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
  // 過期列視同未命中;實體刪除交給維護迴圈,避免在熱路徑上多一次寫入。
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
  // 超過上限的回應不落地(串流長回應可能很大):靜默跳過,完成鍵重送
  // 退回 409 語意,不影響計費與回應本身。
  if (payloadBytes > MAX_REPLAY_PAYLOAD_BYTES) return false;
  await ensureAiSchema(env);
  const result = await dbQuery(
    env,
    `
    INSERT INTO ai_idempotency_replays (
      request_id, api_key_id, idempotency_key, request_fingerprint,
      endpoint, response_status, content_type, response_payload,
      payload_bytes, expires_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT DO NOTHING
    RETURNING request_id
  `,
    [
      input.requestId,
      input.apiKeyId,
      input.idempotencyKey,
      input.requestFingerprint,
      input.endpoint,
      input.status ?? 200,
      input.contentType,
      input.payload,
      payloadBytes,
      new Date(Date.now() + ttlSeconds * 1000).toISOString(),
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
