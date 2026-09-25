import { AKENTROS_REPLAY_TOMBSTONE_CONTENT_TYPE } from "@akentros/core/billing";
import type { AkentrosRuntimeEnv } from "../types.ts";
import { AkentrosError } from "./aiErrors.ts";
import { ensureAiSchema } from "./aiSchema.ts";
import { dbQuery } from "./db.ts";

// 冪等重放儲存(schema v3 的 ai_idempotency_replays):金鑰 opt-in
// (ai_api_keys.idempotency_replay_ttl_seconds > 0)時,成功回應以
// request_id 落地 TTL 秒;完成鍵重送且指紋一致時直接重放原始回應,
// 補齊與 OpenAI 冪等語意的差異。金鑰未 opt-in 時不讀寫本表,行為
// 維持 409 idempotent_request_replayed,「不落地 prompt/completion」
// 的預設隱私立場不變。
//
// 生命周期(issue #13):TTL 是重放窗口,不是金鑰的死刑。窗口內——真列
// 重放原始回應;超過 MAX_REPLAY_PAYLOAD_BYTES 的回應落地 tombstone
// (同 TTL),同鍵重送得到可分辨的 409 idempotency_replay_not_stored,
// 不重放也不重新執行(避免雙重扣費)。窗口過期——billing.reserve 釋放
// 綁定,同鍵重送以全新請求重新執行,新回應經 ON CONFLICT DO UPDATE
// 覆寫過期列(維護迴圈 */30 才清理,不可仰賴 DO NOTHING)。

const MAX_REPLAY_PAYLOAD_BYTES = 2 * 1024 * 1024;

function rows(result: any): any[] {
  return Array.isArray(result?.rows) ? result.rows : [];
}

function nowIso() {
  return new Date().toISOString();
}

export interface AkentrosIdempotentReplayResponse {
  status: number;
  contentType: string;
  payload: string;
  /** 被重放的原始請求 ID;管理面以 replay_of_request_id 呈現。 */
  requestId: string;
}

export async function readAkentrosIdempotentReplay(
  env: AkentrosRuntimeEnv,
  input: {
    apiKeyId: string | number;
    idempotencyKey: string;
    requestFingerprint: string;
  },
): Promise<AkentrosIdempotentReplayResponse | null> {
  await ensureAiSchema(env);
  const result = await dbQuery(
    env,
    `
    SELECT request_id, request_fingerprint, response_status, content_type, response_payload, expires_at
    FROM ai_idempotency_replays
    WHERE api_key_id = ? AND idempotency_key = ?
    LIMIT 1
  `,
    [input.apiKeyId, input.idempotencyKey],
  );
  const row: any = rows(result)[0];
  if (!row) return null;
  // 過期列視同未命中:綁定釋放與重新執行由 billing.reserve 的交易處理,
  // 實體刪除交給維護迴圈,避免在熱路徑上多一次寫入。
  if (String(row.expires_at) <= nowIso()) return null;
  // 指紋不一致 = 同一冪等鍵綁不同的請求體,與 billing.reserve 的立場一致。
  if (String(row.request_fingerprint) !== String(input.requestFingerprint)) {
    throw new AkentrosError("The Idempotency-Key was already used with a different request.", {
      status: 409,
      type: "invalid_request_error",
      code: "idempotency_conflict",
      param: "Idempotency-Key",
    });
  }
  // tombstone(回應超過落地上限):綁定在 TTL 內,但回應不可重放。回可
  // 分辨的 409,讓客戶端知道「換新鍵可重新執行」,而非被誤導性的
  // idempotent_request_replayed 永久卡死。
  if (String(row.content_type) === AKENTROS_REPLAY_TOMBSTONE_CONTENT_TYPE) {
    throw new AkentrosError(
      "The original response for this Idempotency-Key exceeded the replay storage limit and cannot be replayed; send a new Idempotency-Key to execute the request again.",
      {
        status: 409,
        type: "invalid_request_error",
        code: "idempotency_replay_not_stored",
        param: "Idempotency-Key",
      },
    );
  }
  return {
    status: Number(row.response_status) || 200,
    contentType: String(row.content_type || "application/json"),
    payload: String(row.response_payload),
    requestId: String(row.request_id),
  };
}

// 重放命中落一列輕量請求紀錄(status='replayed',計費欄位全 0):重放不執行
// 推論、不走 reserve,但不記錄就會在管理面的請求紀錄中完全隱形。寫入失敗
// 不影響重放回應本身。
export async function recordAkentrosIdempotentReplay(
  env: AkentrosRuntimeEnv,
  input: {
    requestId: string;
    replayedRequestId: string;
    userId: string | number;
    apiKeyId: string | number;
    requestFingerprint: string;
    endpoint: string;
    stream: boolean;
    publicModel: string;
    pricingRevision: string;
  },
): Promise<void> {
  await ensureAiSchema(env);
  await dbQuery(
    env,
    `
    INSERT INTO ai_requests (
      request_id, user_id, api_key_id, idempotency_key, request_fingerprint,
      endpoint, stream, public_model, pricing_revision, pricing_snapshot,
      reserved_usd_micros, charged_usd_micros, refunded_usd_micros,
      status, http_status, replay_of_request_id, finalized_at, created_at, updated_at
    )
    VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, '{}', 0, 0, 0, 'replayed', 200, ?, ?, ?, ?)
  `,
    [
      input.requestId,
      input.userId,
      input.apiKeyId,
      input.requestFingerprint,
      input.endpoint,
      input.stream ? 1 : 0,
      input.publicModel,
      input.pricingRevision,
      input.replayedRequestId,
      nowIso(),
      nowIso(),
      nowIso(),
    ],
  );
}

export async function saveAkentrosIdempotentReplay(
  env: AkentrosRuntimeEnv,
  input: {
    requestId: string;
    apiKeyId: string | number;
    idempotencyKey: string;
    requestFingerprint: string;
    endpoint: string;
    contentType: string;
    payload: string;
    ttlSeconds: number;
    status?: number;
  },
): Promise<boolean> {
  const ttlSeconds = Number(input.ttlSeconds);
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) return false;
  const payloadBytes = new TextEncoder().encode(input.payload).byteLength;
  // 超過上限的回應(串流長回應可能很大)無法重放:改落 tombstone(同
  // TTL),把「綁定存在但回應不可重放」變成可分辨的 409
  // idempotency_replay_not_stored——不重放、不重新執行、不雙重扣費;
  // TTL 過期後綁定隨 tombstone 一起釋放,同鍵可重新執行。
  const oversized = payloadBytes > MAX_REPLAY_PAYLOAD_BYTES;
  await ensureAiSchema(env);
  // ON CONFLICT DO UPDATE(僅限既有列已過期且指紋一致):TTL 過期後的
  // 重新執行要把新回應覆寫到過期但尚未被維護迴圈清理的列上;DO
  // NOTHING 會靜默吞掉新回應,讓同鍵重送在下一個窗口內重放到舊回應。
  const result = await dbQuery(
    env,
    `
    INSERT INTO ai_idempotency_replays (
      request_id, api_key_id, idempotency_key, request_fingerprint,
      endpoint, response_status, content_type, response_payload,
      payload_bytes, expires_at, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (api_key_id, idempotency_key) DO UPDATE SET
      request_id = excluded.request_id,
      request_fingerprint = excluded.request_fingerprint,
      endpoint = excluded.endpoint,
      response_status = excluded.response_status,
      content_type = excluded.content_type,
      response_payload = excluded.response_payload,
      payload_bytes = excluded.payload_bytes,
      expires_at = excluded.expires_at,
      created_at = excluded.created_at
    WHERE ai_idempotency_replays.request_fingerprint = excluded.request_fingerprint
      AND ai_idempotency_replays.expires_at <= ?
    RETURNING request_id
  `,
    [
      input.requestId,
      input.apiKeyId,
      input.idempotencyKey,
      input.requestFingerprint,
      input.endpoint,
      oversized ? 200 : (input.status ?? 200),
      oversized ? AKENTROS_REPLAY_TOMBSTONE_CONTENT_TYPE : input.contentType,
      oversized ? "" : input.payload,
      oversized ? 0 : payloadBytes,
      new Date(Date.now() + ttlSeconds * 1000).toISOString(),
      nowIso(),
      nowIso(),
    ],
  );
  return rows(result).length > 0;
}

export async function cleanupAkentrosIdempotentReplays(env: AkentrosRuntimeEnv) {
  await ensureAiSchema(env);
  const result = await dbQuery(
    env,
    `
    DELETE FROM ai_idempotency_replays
    WHERE expires_at <= ?
    RETURNING request_id
  `,
    [nowIso()],
  );
  return rows(result).length;
}
