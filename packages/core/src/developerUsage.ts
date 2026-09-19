import { usdMicrosToDecimalString } from "./pricing.ts";

const REQUEST_STATUSES = new Set([
  "pending_reservation",
  "reserved",
  "dispatched",
  "succeeded",
  "partially_succeeded",
  "rejected",
  "refunded",
  "needs_reconciliation",
  // 冪等重放命中:不執行、不計費,僅為管理面可見性落一列輕量紀錄。
  "replayed",
]);
const REQUEST_ID = /^req_[A-Za-z0-9_-]{8,76}$/;
const PUBLIC_ERROR_CODES = new Set([
  "invalid_api_key",
  "account_banned",
  "service_restricted",
  "insufficient_scope",
  "model_not_found",
  "model_not_allowed",
  "invalid_request",
  "invalid_json",
  "unsupported_parameter",
  "unsupported_feature",
  "context_length_exceeded",
  "request_too_large",
  "spend_limit_exceeded",
  "insufficient_balance",
  "free_quota_exceeded",
  "rate_limit_exceeded",
  "max_in_flight_exceeded",
  "idempotent_request_in_progress",
  "idempotent_request_replayed",
  "request_cancelled",
]);

function rows(result: any): any[] {
  return Array.isArray(result?.rows) ? result.rows : [];
}

function safeNumber(value: any) {
  const number = Number(value || 0);
  return Number.isSafeInteger(number) ? number : String(value || 0);
}

function encodeCursor(row: any) {
  const text = `${new Date(row.created_at).toISOString()}|${row.id}`;
  const binary = String.fromCharCode(...new TextEncoder().encode(text));
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeCursor(cursor: any) {
  if (!cursor) return null;
  try {
    const padded =
      String(cursor).replaceAll("-", "+").replaceAll("_", "/") +
      "=".repeat((4 - (String(cursor).length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
    const [timestamp, id, ...rest] = new TextDecoder().decode(bytes).split("|");
    if (rest.length || Number.isNaN(Date.parse(timestamp)) || !/^[1-9][0-9]*$/.test(id)) return null;
    return { timestamp: new Date(timestamp).toISOString(), id };
  } catch {
    return null;
  }
}

function isoDate(value: any, label: string) {
  if (!value) return null;
  const timestamp = Date.parse(String(value));
  if (Number.isNaN(timestamp)) throw new TypeError(`${label} must be an ISO 8601 timestamp.`);
  return new Date(timestamp).toISOString();
}

function publicErrorCode(value: any) {
  if (!value) return null;
  if (value === "client_disconnected") return "request_cancelled";
  const code = String(value);
  return PUBLIC_ERROR_CODES.has(code) ? code : "service_unavailable";
}

function normalizeLog(row: any) {
  const requestedModel = String(row.public_model);
  return {
    request_id: String(row.request_id),
    created_at: new Date(row.created_at).toISOString(),
    completed_at: row.finalized_at ? new Date(row.finalized_at).toISOString() : null,
    api_key_id: row.api_key_id == null ? null : String(row.api_key_id),
    key_name: row.key_name || null,
    requested_model: requestedModel,
    actual_model: requestedModel,
    provider: "akentros",
    status: String(row.status),
    input_tokens: safeNumber(row.input_tokens),
    output_tokens: safeNumber(row.output_tokens),
    total_tokens: safeNumber(row.total_tokens),
    reserved_usd_micros: safeNumber(row.reserved_usd_micros),
    charged_usd_micros: safeNumber(row.charged_usd_micros),
    refunded_usd_micros: safeNumber(row.refunded_usd_micros),
    latency_ms: row.total_latency_ms == null ? null : Number(row.total_latency_ms),
    first_token_latency_ms: row.first_token_ms == null ? null : Number(row.first_token_ms),
    error_code: publicErrorCode(row.error_code),
    replay_of_request_id: row.replay_of_request_id == null ? null : String(row.replay_of_request_id),
  };
}

export function createAkentrosDeveloperUsageStore(query: any) {
  if (typeof query !== "function") throw new TypeError("A database query function is required.");
  return Object.freeze({
    async summary(userId: any) {
      // 30 天窗口的截止時間由呼叫端綁定(SQLite 無 CURRENT_TIMESTAMP - INTERVAL)。
      const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
      const result = await query(
        `
        SELECT users.balance_usd_micros,
               COUNT(requests.id) FILTER (
                 WHERE requests.created_at >= ?
               ) AS requests,
               COUNT(requests.id) FILTER (
                 WHERE requests.created_at >= ?
                   AND requests.status IN ('succeeded', 'partially_succeeded')
               ) AS succeeded,
               COUNT(requests.id) FILTER (
                 WHERE requests.created_at >= ?
                   AND requests.status IN ('rejected', 'refunded')
               ) AS failed,
               COALESCE(SUM(requests.input_tokens) FILTER (
                 WHERE requests.created_at >= ?
               ), 0) AS input_tokens,
               COALESCE(SUM(requests.output_tokens) FILTER (
                 WHERE requests.created_at >= ?
               ), 0) AS output_tokens,
               COALESCE(SUM(requests.total_tokens) FILTER (
                 WHERE requests.created_at >= ?
               ), 0) AS total_tokens,
               COALESCE(SUM(requests.charged_usd_micros) FILTER (
                 WHERE requests.created_at >= ?
               ), 0) AS charged_usd_micros
        FROM users
        LEFT JOIN ai_requests AS requests ON requests.user_id = users.id
        WHERE users.id = ?
        GROUP BY users.id, users.balance_usd_micros
      `,
        [cutoff, cutoff, cutoff, cutoff, cutoff, cutoff, cutoff, String(userId)],
      );
      const row = rows(result)[0];
      if (!row) return null;
      return {
        balance_usd: usdMicrosToDecimalString(row.balance_usd_micros || 0),
        requests: safeNumber(row.requests),
        succeeded: safeNumber(row.succeeded),
        failed: safeNumber(row.failed),
        input_tokens: safeNumber(row.input_tokens),
        output_tokens: safeNumber(row.output_tokens),
        total_tokens: safeNumber(row.total_tokens),
        charged_usd: usdMicrosToDecimalString(row.charged_usd_micros || 0),
        period_days: 30,
        free_model_quotas: {},
      };
    },

    async list(userId: any, options: any = {}) {
      const limit = Math.min(Math.max(Number(options.limit) || 25, 1), 100);
      const cursor = options.cursor ? decodeCursor(options.cursor) : null;
      if (options.cursor && !cursor) throw new TypeError("cursor is invalid.");
      const from = isoDate(options.from, "from");
      const to = isoDate(options.to, "to");
      if (from && to && Date.parse(from) > Date.parse(to)) throw new TypeError("from must not be after to.");
      const status = options.status ? String(options.status) : null;
      if (status && !REQUEST_STATUSES.has(status)) throw new TypeError("status is invalid.");
      const model = options.model ? String(options.model).trim().slice(0, 200) : null;
      if (options.keyId && !/^[1-9][0-9]*$/.test(String(options.keyId))) {
        throw new TypeError("key_id is invalid.");
      }
      const keyId = options.keyId ? String(options.keyId) : null;

      const conditions = ["requests.user_id = ?"];
      const params: any[] = [String(userId)];
      if (cursor) {
        // created_at 在 SQLite 方言下即為毫秒精度 ISO 字串,排序鍵與游標鍵
        // 天然對齊;row-value 比較避免同毫秒內漏頁。
        conditions.push("(requests.created_at, requests.id) < (?, ?)");
        params.push(cursor.timestamp, cursor.id);
      }
      if (from) {
        conditions.push("requests.created_at >= ?");
        params.push(from);
      }
      if (to) {
        conditions.push("requests.created_at <= ?");
        params.push(to);
      }
      if (status) {
        conditions.push("requests.status = ?");
        params.push(status);
      }
      if (model) {
        conditions.push("requests.public_model = ?");
        params.push(model);
      }
      if (keyId) {
        conditions.push("requests.api_key_id = ?");
        params.push(keyId);
      }
      params.push(limit + 1);

      const result = await query(
        `
        SELECT requests.*, keys.name AS key_name
        FROM ai_requests AS requests
        LEFT JOIN ai_api_keys AS keys ON keys.id = requests.api_key_id
        WHERE ${conditions.join(" AND ")}
        ORDER BY requests.created_at DESC, requests.id DESC
        LIMIT ?
      `,
        params,
      );
      const page = rows(result);
      const hasMore = page.length > limit;
      const visible = page.slice(0, limit);
      return {
        logs: visible.map(normalizeLog),
        pagination: {
          has_more: hasMore,
          next_cursor: hasMore && visible.length ? encodeCursor(visible.at(-1)) : null,
        },
      };
    },

    async detail(userId: any, requestId: any) {
      if (!REQUEST_ID.test(String(requestId))) throw new TypeError("requestId is invalid.");
      const result = await query(
        `
        SELECT requests.*, keys.name AS key_name
        FROM ai_requests AS requests
        LEFT JOIN ai_api_keys AS keys ON keys.id = requests.api_key_id
        WHERE requests.user_id = ? AND requests.request_id = ?
      `,
        [String(userId), String(requestId)],
      );
      const row = rows(result)[0];
      if (!row) return null;
      return {
        ...normalizeLog(row),
        pricing_revision: row.pricing_revision || null,
      };
    },
  });
}
