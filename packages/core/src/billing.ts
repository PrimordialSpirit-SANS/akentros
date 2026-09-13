import { BeaconError, invalidRequest } from "./openaiErrors.ts";

const DECIMAL_INTEGER = /^(0|[1-9][0-9]*)$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const FINAL_STATUSES = new Set(["succeeded", "partially_succeeded"]);

function rows(result: any): any[] {
  return Array.isArray(result?.rows) ? result.rows : [];
}

function requiredString(value: unknown, label: string, maxLength: number) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > maxLength) {
    throw new TypeError(`${label} must be a non-empty string of at most ${maxLength} characters.`);
  }
  return normalized;
}

function optionalString(value: unknown, label: string, maxLength: number) {
  if (value === null || value === undefined || value === "") return null;
  return requiredString(value, label, maxLength);
}

function integerString(value: unknown, label: string, { allowZero = true }: { allowZero?: boolean } = {}) {
  const normalized = typeof value === "bigint" ? value.toString() : String(value ?? "");
  if (!DECIMAL_INTEGER.test(normalized) || (!allowZero && normalized === "0")) {
    throw new TypeError(`${label} must be ${allowZero ? "a non-negative" : "a positive"} integer.`);
  }
  return normalized;
}

function safeNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : String(value);
}

function normalizeBillingRow(row: any, idempotentReplay = Boolean(row?.idempotent_replay)) {
  if (!row) return null;
  return {
    requestId: String(row.request_id),
    aiRequestId: String(row.ai_request_id ?? row.id),
    requestFingerprint: String(row.request_fingerprint || ""),
    status: String(row.status),
    reservationState: row.reservation_state ? String(row.reservation_state) : null,
    reservedCostMicros: safeNumber(row.reserved_usd_micros || 0),
    chargedCostMicros: safeNumber(row.charged_usd_micros || 0),
    refundedCostMicros: safeNumber(row.refunded_usd_micros || 0),
    errorCode: row.error_code ? String(row.error_code) : null,
    httpStatus: row.http_status === null || row.http_status === undefined ? null : Number(row.http_status),
    idempotentReplay,
  };
}

// tools[].function.parameters 允許任意深度 JSON;請求指紋的 stableJson 以
//遞迴序列化,無深度上限時可在 128KB body 內塞出數萬層巢狀造成堆疊溢位
//(RangeError → 503)。超過上限改以明確的 4xx 拒絕。
const STABLE_JSON_MAX_DEPTH = 32;

function stableJson(value: any, depth = 0): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (depth >= STABLE_JSON_MAX_DEPTH) {
    throw invalidRequest("The request contains JSON nested deeper than the supported limit.", "tools");
  }
  if (Array.isArray(value)) return `[${value.map((item: any) => stableJson(item, depth + 1)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key], depth + 1)}`).join(",")}}`;
}

export async function createBeaconRequestFingerprint(value: any) {
  const bytes = new TextEncoder().encode(stableJson(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// SQLite 方言:時間戳以 UTC ISO 字串(含毫秒)存 TEXT,由呼叫端綁定;
// 原子性由 transaction(fn)(BEGIN IMMEDIATE … COMMIT)保證,取代
// PostgreSQL 時代的單語句資料修改 CTE。
export const BEACON_BILLING_SQL = Object.freeze({
  read: `
    SELECT requests.id AS ai_request_id, requests.request_id,
           requests.request_fingerprint, requests.status,
           requests.reserved_usd_micros, requests.charged_usd_micros, requests.refunded_usd_micros,
           requests.error_code, requests.http_status,
           reservations.state AS reservation_state,
           TRUE AS idempotent_replay
    FROM ai_requests AS requests
    LEFT JOIN ai_billing_reservations AS reservations
      ON reservations.ai_request_id = requests.id
    WHERE requests.request_id = ?
  `,
  readIdempotency: `
    SELECT requests.id AS ai_request_id, requests.request_id,
           requests.request_fingerprint, requests.status,
           requests.reserved_usd_micros, requests.charged_usd_micros, requests.refunded_usd_micros,
           requests.error_code, requests.http_status,
           reservations.state AS reservation_state,
           TRUE AS idempotent_replay
    FROM ai_requests AS requests
    LEFT JOIN ai_billing_reservations AS reservations
      ON reservations.ai_request_id = requests.id
    WHERE requests.api_key_id = ? AND requests.idempotency_key = ?
  `,
  dispatch: `
    UPDATE ai_requests
    SET status = 'dispatched', dispatched_at = COALESCE(dispatched_at, ?),
        updated_at = ?
    WHERE request_id = ? AND status = 'reserved'
    RETURNING id AS ai_request_id, request_id, request_fingerprint, status,
              reserved_usd_micros, charged_usd_micros, refunded_usd_micros, error_code, http_status
  `,
  quarantinedStale: `
    SELECT reservations.request_id
    FROM ai_billing_reservations AS reservations
    WHERE reservations.state = 'needs_reconciliation'
      AND reservations.updated_at <= ?
    ORDER BY reservations.updated_at, reservations.id
    LIMIT ?
  `,
  stale: `
    SELECT reservations.request_id, requests.dispatched_at
    FROM ai_billing_reservations AS reservations
    JOIN ai_requests AS requests ON requests.id = reservations.ai_request_id
    WHERE reservations.state = 'reserved'
      AND reservations.expires_at <= ?
    ORDER BY reservations.expires_at, reservations.id
    LIMIT ?
  `,
});

function nowIso() {
  return new Date().toISOString();
}

function idempotencyConflict() {
  return new BeaconError("The Idempotency-Key was already used with a different request.", {
    status: 409,
    type: "invalid_request_error",
    code: "idempotency_conflict",
    param: "Idempotency-Key",
  });
}

function insufficientPoints(requestId: string) {
  const error = new BeaconError("The account does not have enough points for this request.", {
    status: 402,
    type: "insufficient_funds_error",
    code: "insufficient_balance",
  });
  error.requestId = requestId;
  return error;
}

function pointLimitExceeded(requestId: string) {
  const error = new BeaconError("This API key has reached its maximum point spend.", {
    status: 402,
    type: "insufficient_funds_error",
    code: "spend_limit_exceeded",
  });
  error.requestId = requestId;
  return error;
}

function invalidBillingState(message: string) {
  return new BeaconError(message, {
    status: 409,
    type: "invalid_request_error",
    code: "invalid_billing_state",
  });
}

// 執行交易:query 介面可選提供 transaction(fn)(SQLite adapter 有提供;
// 測試的假 query 沒有時,退回逐語句執行)。
async function withTransaction(query: any, fn: () => Promise<any>) {
  if (typeof query?.transaction === "function") {
    return query.transaction(fn);
  }
  return fn();
}

export function createBeaconBillingStore(query: any) {
  if (typeof query !== "function") {
    throw new TypeError("createBeaconBillingStore requires a database query function.");
  }

  async function read(requestId: string) {
    const result = await query(BEACON_BILLING_SQL.read, [requiredString(requestId, "requestId", 80)]);
    return normalizeBillingRow(rows(result)[0], true);
  }

  return Object.freeze({
    async reserve(input: any) {
      const requestId = requiredString(input?.requestId, "requestId", 80);
      const userId = integerString(input?.userId, "userId", { allowZero: false });
      const apiKeyId = integerString(input?.apiKeyId, "apiKeyId", { allowZero: false });
      const idempotencyKey = optionalString(input?.idempotencyKey, "idempotencyKey", 200);
      const fingerprint = requiredString(input?.requestFingerprint, "requestFingerprint", 64);
      if (!SHA256_HEX.test(fingerprint)) {
        throw new TypeError("requestFingerprint must be a lowercase SHA-256 digest.");
      }
      const endpoint = requiredString(input?.endpoint || "chat.completions", "endpoint", 80);
      const publicModel = requiredString(input?.publicModel, "publicModel", 200);
      const pricingRevision = requiredString(input?.pricingRevision, "pricingRevision", 80);
      const reservedCostMicros = integerString(input?.reservedCostMicros, "reservedCostMicros");
      const expiresAt = requiredString(input?.expiresAt, "expiresAt", 64);
      if (Number.isNaN(Date.parse(expiresAt))) {
        throw new TypeError("expiresAt must be an ISO 8601 timestamp.");
      }

      // 冪等重放:同 (api_key_id, idempotency_key) 已存在時直接回讀,
      // 不建立新請求、不扣點。
      if (idempotencyKey) {
        const replayed = await query(BEACON_BILLING_SQL.readIdempotency, [apiKeyId, idempotencyKey]);
        const replayRow: any = rows(replayed)[0];
        if (replayRow) {
          if (String(replayRow.request_fingerprint) !== fingerprint) throw idempotencyConflict();
          return normalizeBillingRow(replayRow, true)!;
        }
      }

      return withTransaction(query, async () => {
        const now = nowIso();
        const keyRows = await query(
          `
          SELECT spend_limit_usd_micros, spend_used_usd_micros, spend_reserved_usd_micros
          FROM ai_api_keys
          WHERE id = ? AND is_active = TRUE AND revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at > ?)
        `,
          [apiKeyId, now],
        );
        const keyRow: any = rows(keyRows)[0];

        const userRows = await query(
          `
          SELECT id, username, display_name, email, balance_usd_micros
          FROM users WHERE id = ?
        `,
          [userId],
        );
        const userRow: any = rows(userRows)[0];

        // 拒絕判定與原單語句版本的 CASE 邏輯一致:
        // 金鑰無效 → 401;消費上限 → 402 spend_limit;餘額不足(或無帳號)→ 402 balance。
        let status = "reserved";
        let errorCode: string | null = null;
        let httpStatus: number | null = null;
        if (!keyRow) {
          status = "rejected";
          errorCode = "invalid_api_key";
          httpStatus = 401;
        } else {
          const spendLimit = keyRow.spend_limit_usd_micros;
          if (
            spendLimit !== null &&
            spendLimit !== undefined &&
            Number(spendLimit) <
              Number(keyRow.spend_used_usd_micros) +
                Number(keyRow.spend_reserved_usd_micros) +
                Number(reservedCostMicros)
          ) {
            status = "rejected";
            errorCode = "spend_limit_exceeded";
            httpStatus = 402;
          } else if (!userRow || Number(userRow.balance_usd_micros) < Number(reservedCostMicros)) {
            status = "rejected";
            errorCode = "insufficient_balance";
            httpStatus = 402;
          }
        }

        const inserted = await query(
          `
          INSERT INTO ai_requests (
            request_id, user_id, api_key_id, idempotency_key, request_fingerprint,
            endpoint, stream, public_model, pricing_revision, pricing_snapshot,
            reserved_usd_micros, status, error_code, http_status, finalized_at,
            created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT DO NOTHING
          RETURNING id
        `,
          [
            requestId,
            userId,
            apiKeyId,
            idempotencyKey,
            fingerprint,
            endpoint,
            Boolean(input?.stream),
            publicModel,
            pricingRevision,
            JSON.stringify(input?.pricingSnapshot || {}),
            reservedCostMicros,
            status,
            errorCode,
            httpStatus,
            status === "rejected" ? now : null,
            now,
            now,
          ],
        );
        const insertedRow: any = rows(inserted)[0];
        if (!insertedRow && idempotencyKey) {
          // 併發下同一冪等鍵剛被別的請求建立:回讀。
          const replayed = await query(BEACON_BILLING_SQL.readIdempotency, [apiKeyId, idempotencyKey]);
          const replayRow: any = rows(replayed)[0];
          if (!replayRow) throw invalidBillingState("The reservation could not be created.");
          if (String(replayRow.request_fingerprint) !== fingerprint) throw idempotencyConflict();
          return normalizeBillingRow(replayRow, true)!;
        }
        if (!insertedRow) throw invalidBillingState("The reservation could not be created.");
        const aiRequestId = insertedRow.id;

        if (status === "reserved") {
          await query(
            `
            UPDATE ai_api_keys
            SET spend_reserved_usd_micros = spend_reserved_usd_micros + ?, updated_at = ?
            WHERE id = ?
          `,
            [reservedCostMicros, now, apiKeyId],
          );

          const balanceBefore = userRow.balance_usd_micros;
          const balanceAfter = Number(userRow.balance_usd_micros) - Number(reservedCostMicros);
          await query(
            `
            UPDATE users
            SET balance_usd_micros = balance_usd_micros - ?, updated_at = ?
            WHERE id = ?
          `,
            [reservedCostMicros, now, userId],
          );

          await query(
            `
            INSERT INTO ai_billing_reservations (
              ai_request_id, request_id, user_id, reserved_usd_micros, state, expires_at
            )
            VALUES (?, ?, ?, ?, 'reserved', ?)
          `,
            [aiRequestId, requestId, userId, reservedCostMicros, expiresAt],
          );

          if (Number(reservedCostMicros) > 0) {
            await query(
              `
              INSERT INTO ledger_entries (
                user_id, user_name, user_email, direction, amount,
                balance_before, balance_after, transaction_type,
                source_type, source_id, idempotency_key, description, metadata
              )
              VALUES (?, ?, ?, 'debit', ?, ?, ?, 'ai_usage_reservation', 'beacon_ai', ?, ?, 'Beacon usage reservation', ?)
            `,
              [
                userId,
                String(userRow.display_name || "").trim() ? userRow.display_name : userRow.username || "",
                userRow.email || "",
                reservedCostMicros,
                balanceBefore,
                balanceAfter,
                aiRequestId,
                requestId,
                JSON.stringify({
                  request_id: requestId,
                  public_model: publicModel,
                  pricing_revision: pricingRevision,
                }),
              ],
            );
          }
        }

        const normalized = normalizeBillingRow(
          {
            ai_request_id: aiRequestId,
            request_id: requestId,
            request_fingerprint: fingerprint,
            status,
            reserved_usd_micros: reservedCostMicros,
            charged_usd_micros: 0,
            refunded_usd_micros: 0,
            error_code: errorCode,
            http_status: httpStatus,
            reservation_state: status === "reserved" ? "reserved" : null,
            idempotent_replay: false,
          },
          false,
        )!;
        if (normalized.errorCode === "invalid_api_key") {
          // 金鑰在 authenticateBeaconApiKey 與 reserve 之間被撤銷/過期:
          // 應回 401 invalid_api_key,而不是誤標成 402 spend_limit_exceeded。
          const error = new BeaconError("The Beacon API key is invalid, expired, or revoked.", {
            status: 401,
            type: "authentication_error",
            code: "invalid_api_key",
          });
          error.requestId = normalized.requestId;
          throw error;
        }
        if (normalized.errorCode === "spend_limit_exceeded") throw pointLimitExceeded(normalized.requestId);
        if (normalized.errorCode === "insufficient_balance") throw insufficientPoints(normalized.requestId);
        return normalized;
      });
    },

    read,

    async markDispatched(requestId: string) {
      const normalizedId = requiredString(requestId, "requestId", 80);
      const result = await query(BEACON_BILLING_SQL.dispatch, [nowIso(), nowIso(), normalizedId]);
      return normalizeBillingRow(rows(result)[0], false) || (await read(normalizedId));
    },

    async settle(input: any) {
      const requestId = requiredString(input?.requestId, "requestId", 80);
      const actualCostMicros = integerString(input?.actualCostMicros, "actualCostMicros");
      const inputTokens = integerString(input?.inputTokens, "inputTokens");
      const outputTokens = integerString(input?.outputTokens, "outputTokens");
      const totalTokens = (BigInt(inputTokens) + BigInt(outputTokens)).toString();
      const usageSource = requiredString(input?.usageSource || "provider", "usageSource", 24);
      const finalStatus = input?.status || "succeeded";
      if (!FINAL_STATUSES.has(finalStatus)) throw new TypeError("Unsupported billing final status.");
      const latency =
        input?.totalLatencyMs === null || input?.totalLatencyMs === undefined
          ? null
          : Number(input.totalLatencyMs);
      if (latency !== null && (!Number.isSafeInteger(latency) || latency < 0)) {
        throw new TypeError("totalLatencyMs must be a non-negative safe integer.");
      }

      const settled = await withTransaction(query, async () => {
        const now = nowIso();
        const transitioned = await query(
          `
          UPDATE ai_billing_reservations
          SET state = 'settled',
              charged_usd_micros = ?,
              refunded_usd_micros = CAST(reserved_usd_micros - ? AS INTEGER),
              settled_at = ?, updated_at = ?
          WHERE request_id = ? AND state = 'reserved'
            AND (? > 0 OR reserved_usd_micros = 0)
          RETURNING id, ai_request_id, user_id, state, reserved_usd_micros, charged_usd_micros, refunded_usd_micros
        `,
          [actualCostMicros, actualCostMicros, now, now, requestId, actualCostMicros],
        );
        const transition: any = rows(transitioned)[0];
        if (!transition) return null;

        const requestRows = await query(
          `SELECT api_key_id, reserved_usd_micros FROM ai_requests WHERE id = ?`,
          [transition.ai_request_id],
        );
        const request: any = rows(requestRows)[0];

        await query(
          `
          UPDATE ai_api_keys
          SET spend_reserved_usd_micros = MAX(0, spend_reserved_usd_micros - ?),
              spend_used_usd_micros = spend_used_usd_micros + ?,
              updated_at = ?
          WHERE id = ?
        `,
          [request.reserved_usd_micros, transition.charged_usd_micros, now, request.api_key_id],
        );

        const userRows = await query(
          `SELECT id, username, display_name, email, balance_usd_micros FROM users WHERE id = ?`,
          [transition.user_id],
        );
        const user: any = rows(userRows)[0];

        if (Number(transition.refunded_usd_micros) > 0) {
          const balanceBefore = Number(user.balance_usd_micros) - Number(transition.refunded_usd_micros);
          await query(
            `
            UPDATE users
            SET balance_usd_micros = balance_usd_micros + ?, updated_at = ?
            WHERE id = ?
          `,
            [transition.refunded_usd_micros, now, transition.user_id],
          );
          await query(
            `
            INSERT INTO ledger_entries (
              user_id, user_name, user_email, direction, amount,
              balance_before, balance_after, transaction_type,
              source_type, source_id, idempotency_key, description, metadata
            )
            VALUES (?, ?, ?, 'credit', ?, ?, ?, 'ai_usage_refund', 'beacon_ai', ?, ?, 'Beacon unused reservation refund', ?)
          `,
            [
              transition.user_id,
              String(user.display_name || "").trim() ? user.display_name : user.username || "",
              user.email || "",
              transition.refunded_usd_micros,
              balanceBefore,
              user.balance_usd_micros,
              transition.ai_request_id,
              requestId,
              JSON.stringify({ request_id: requestId, charged_usd_micros: transition.charged_usd_micros }),
            ],
          );
        }

        const finalized = await query(
          `
          UPDATE ai_requests
          SET input_tokens = ?, output_tokens = ?, total_tokens = ?, usage_source = ?,
              charged_usd_micros = ?, refunded_usd_micros = ?,
              status = ?, error_code = NULL, http_status = 200,
              total_latency_ms = ?, finalized_at = ?, updated_at = ?
          WHERE id = ?
          RETURNING id AS ai_request_id, request_id, request_fingerprint, status,
                    reserved_usd_micros, charged_usd_micros, refunded_usd_micros,
                    error_code, http_status
        `,
          [
            inputTokens,
            outputTokens,
            totalTokens,
            usageSource,
            transition.charged_usd_micros,
            transition.refunded_usd_micros,
            finalStatus,
            latency,
            now,
            now,
            transition.ai_request_id,
          ],
        );
        const row: any = rows(finalized)[0];
        return row ? { ...row, reservation_state: transition.state } : null;
      });

      const changed = normalizeBillingRow(settled, false);
      if (changed) return changed;
      const current = await read(requestId);
      if (current?.reservationState === "settled") return current;
      throw invalidBillingState("The reservation cannot be settled from its current state.");
    },

    async refund(input: any) {
      const requestId = requiredString(input?.requestId, "requestId", 80);
      const reason = requiredString(input?.reason || "provider_failure", "reason", 120);
      const errorCode = requiredString(input?.errorCode || "provider_failure", "errorCode", 80);
      const httpStatus = Number(input?.httpStatus ?? 502);
      if (!Number.isInteger(httpStatus) || httpStatus < 400 || httpStatus > 599) {
        throw new TypeError("httpStatus must be an integer from 400 through 599.");
      }
      return this.refundFromState({
        requestId,
        fromState: "reserved",
        reason,
        errorCode,
        httpStatus,
        description: "Beacon reservation refund",
      });
    },

    // refund 與隔離單退款共用主體,僅「來源狀態」與 ledger 描述不同。
    async refundFromState({ requestId, fromState, reason, errorCode, httpStatus, description }: any) {
      requiredString(requestId, "requestId", 80);
      const refunded = await withTransaction(query, async () => {
        const now = nowIso();
        const transitioned = await query(
          `
          UPDATE ai_billing_reservations
          SET state = 'refunded', charged_usd_micros = 0,
              refunded_usd_micros = reserved_usd_micros,
              settled_at = ?, updated_at = ?
          WHERE request_id = ? AND state = ?
          RETURNING id, ai_request_id, user_id, state, reserved_usd_micros, refunded_usd_micros
        `,
          [now, now, requestId, fromState],
        );
        const transition: any = rows(transitioned)[0];
        if (!transition) return null;

        const requestRows = await query(
          `SELECT api_key_id, reserved_usd_micros FROM ai_requests WHERE id = ?`,
          [transition.ai_request_id],
        );
        const request: any = rows(requestRows)[0];

        await query(
          `
          UPDATE ai_api_keys
          SET spend_reserved_usd_micros = MAX(0, spend_reserved_usd_micros - ?),
              updated_at = ?
          WHERE id = ?
        `,
          [request.reserved_usd_micros, now, request.api_key_id],
        );

        const userRows = await query(
          `SELECT id, username, display_name, email, balance_usd_micros FROM users WHERE id = ?`,
          [transition.user_id],
        );
        const user: any = rows(userRows)[0];

        if (Number(transition.refunded_usd_micros) > 0) {
          const balanceBefore = Number(user.balance_usd_micros) - Number(transition.refunded_usd_micros);
          await query(
            `
            UPDATE users
            SET balance_usd_micros = balance_usd_micros + ?, updated_at = ?
            WHERE id = ?
          `,
            [transition.refunded_usd_micros, now, transition.user_id],
          );
          await query(
            `
            INSERT INTO ledger_entries (
              user_id, user_name, user_email, direction, amount,
              balance_before, balance_after, transaction_type,
              source_type, source_id, idempotency_key, description, metadata
            )
            VALUES (?, ?, ?, 'credit', ?, ?, ?, 'ai_usage_refund', 'beacon_ai', ?, ?, ?, ?)
          `,
            [
              transition.user_id,
              String(user.display_name || "").trim() ? user.display_name : user.username || "",
              user.email || "",
              transition.refunded_usd_micros,
              balanceBefore,
              user.balance_usd_micros,
              transition.ai_request_id,
              requestId,
              description,
              JSON.stringify({ request_id: requestId, reason }),
            ],
          );
        }

        const finalized = await query(
          `
          UPDATE ai_requests
          SET charged_usd_micros = 0, refunded_usd_micros = ?,
              status = 'refunded', error_code = ?, http_status = ?,
              finalized_at = ?, updated_at = ?
          WHERE id = ?
          RETURNING id AS ai_request_id, request_id, request_fingerprint, status,
                    reserved_usd_micros, charged_usd_micros, refunded_usd_micros,
                    error_code, http_status
        `,
          [transition.refunded_usd_micros, errorCode, httpStatus, now, now, transition.ai_request_id],
        );
        const row: any = rows(finalized)[0];
        return row ? { ...row, reservation_state: transition.state } : null;
      });

      const changed = normalizeBillingRow(refunded, false);
      if (changed) return changed;
      const current = await read(requestId);
      if (current?.reservationState === "refunded") return current;
      throw invalidBillingState("The reservation cannot be refunded from its current state.");
    },

    async markNeedsReconciliation(input: any) {
      const requestId = requiredString(input?.requestId, "requestId", 80);
      const errorCode = requiredString(input?.errorCode || "usage_unknown", "errorCode", 80);
      const changed = await withTransaction(query, async () => {
        const now = nowIso();
        const transitioned = await query(
          `
          UPDATE ai_billing_reservations
          SET state = 'needs_reconciliation', updated_at = ?
          WHERE request_id = ? AND state = 'reserved'
          RETURNING id, ai_request_id
        `,
          [now, requestId],
        );
        const transition: any = rows(transitioned)[0];
        if (!transition) return null;
        const finalized = await query(
          `
          UPDATE ai_requests
          SET status = 'needs_reconciliation', error_code = ?, updated_at = ?
          WHERE id = ?
          RETURNING id AS ai_request_id, request_id, request_fingerprint, status,
                    reserved_usd_micros, charged_usd_micros, refunded_usd_micros,
                    error_code, http_status
        `,
          [errorCode, now, transition.ai_request_id],
        );
        const row: any = rows(finalized)[0];
        return row ? { ...row, reservation_state: "needs_reconciliation" } : null;
      });
      return normalizeBillingRow(changed, false) || (await read(requestId));
    },

    async reconcileStale({ limit = 100 }: { limit?: number } = {}) {
      const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
      const result = await query(BEACON_BILLING_SQL.stale, [nowIso(), safeLimit]);
      const bounded = rows(result);
      const outcomes: any[] = [];
      for (const stale of bounded) {
        // 逐列隔離錯誤:單一保留單若在 SELECT 與 UPDATE 之間被併發的
        // settle/refund 改變狀態,只將該列標記為衝突並繼續處理其餘列,
        // 避免一列的暫態衝突讓整批退款延遲到下一個排程週期。
        try {
          if (stale.dispatched_at) {
            outcomes.push(
              await this.markNeedsReconciliation({
                requestId: stale.request_id,
                errorCode: "reservation_expired_after_dispatch",
              }),
            );
          } else {
            outcomes.push(
              await this.refund({
                requestId: stale.request_id,
                reason: "reservation_expired_before_dispatch",
                errorCode: "reservation_expired",
                httpStatus: 504,
              }),
            );
          }
        } catch (error: any) {
          if (error?.code === "invalid_billing_state") {
            outcomes.push({
              requestId: stale.request_id,
              reservationState: "conflict_resolved_concurrently",
            });
            continue;
          }
          throw error;
        }
      }
      return outcomes;
    },

    // needs_reconciliation 原本是死路狀態:進入後既不能 settle 也不能 refund,
    // 使用者的保留點數會永久滯留。此方法把隔離超過一段時間的保留單全額
    // 退還(平台吸收該筆推論成本),讓隔離狀態有明確的自動出口。隔離期內
    // 保留原狀以利人工調查。
    async resolveQuarantinedReservation(input: any) {
      const requestId = requiredString(input?.requestId, "requestId", 80);
      return this.refundFromState({
        requestId,
        fromState: "needs_reconciliation",
        reason: "quarantine_resolved",
        errorCode: "reservation_expired",
        httpStatus: 504,
        description: "Beacon quarantined reservation refund",
      });
    },

    async resolveQuarantined({
      limit = 100,
      olderThanMs = 3_600_000,
    }: {
      limit?: number;
      olderThanMs?: number;
    } = {}) {
      const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
      const safeAge = Math.min(Math.max(Number(olderThanMs) || 3_600_000, 60_000), 30 * 86_400_000);
      const cutoff = new Date(Date.now() - safeAge).toISOString();
      const result = await query(BEACON_BILLING_SQL.quarantinedStale, [cutoff, safeLimit]);
      const outcomes: any[] = [];
      for (const quarantined of rows(result)) {
        // 同 reconcileStale:單列衝突不中斷整批隔離保留單的自動退款。
        try {
          outcomes.push(
            await this.resolveQuarantinedReservation({
              requestId: quarantined.request_id,
            }),
          );
        } catch (error: any) {
          if (error?.code === "invalid_billing_state") {
            outcomes.push({
              requestId: quarantined.request_id,
              reservationState: "conflict_resolved_concurrently",
            });
            continue;
          }
          throw error;
        }
      }
      return outcomes;
    },
  });
}

export async function runBillableBeaconRequest({ billing, reservation, providerCall }: any) {
  if (!billing || typeof billing.reserve !== "function") {
    throw new TypeError("A Beacon billing store is required.");
  }
  if (typeof providerCall !== "function") throw new TypeError("providerCall must be a function.");

  const reserved = await billing.reserve(reservation);
  if (reserved.idempotentReplay) return { kind: "idempotent_replay", billing: reserved };

  await billing.markDispatched(reserved.requestId);
  let providerResult: any;
  try {
    providerResult = await providerCall({ requestId: reserved.requestId });
  } catch (error: any) {
    if (error?.usageUnknown === true) {
      await billing.markNeedsReconciliation({
        requestId: reserved.requestId,
        errorCode: error.code || "usage_unknown",
      });
    } else {
      await billing.refund({
        requestId: reserved.requestId,
        reason: error?.code || "provider_failure",
        errorCode: error?.code || "provider_failure",
        httpStatus: Number(error?.status) >= 400 ? Number(error.status) : 502,
      });
    }
    throw error;
  }

  try {
    const settled = await billing.settle({
      requestId: reserved.requestId,
      actualCostMicros: providerResult.actualCostMicros,
      inputTokens: providerResult.inputTokens,
      outputTokens: providerResult.outputTokens,
      usageSource: providerResult.usageSource || "provider",
      status: providerResult.status || "succeeded",
      totalLatencyMs: providerResult.totalLatencyMs,
    });
    return { kind: "succeeded", billing: settled, provider: providerResult };
  } catch (error) {
    await billing.markNeedsReconciliation({
      requestId: reserved.requestId,
      errorCode: "settlement_failed",
    });
    throw error;
  }
}
