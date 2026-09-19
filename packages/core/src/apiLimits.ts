import { AkentrosError } from "./openaiErrors.ts";

function rows(result: any): any[] {
  return Array.isArray(result?.rows) ? result.rows : [];
}

function positiveInteger(value: unknown, label: string, maximum: number) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new TypeError(`${label} must be a positive integer no greater than ${maximum}.`);
  }
  return parsed;
}

// SQLite 方言:計數視窗以「分鐘起點的 UTC ISO 字串」為鍵,由呼叫端計算後
// 綁定;原子性由 transaction(fn) 保證。RPM / max_in_flight 以資料表內的
// 現值為準(與 authenticate 階段讀到的值可能不同時,以這裡為準)。
export const AKENTROS_API_LIMIT_SQL = Object.freeze({
  acquireKey: `
    SELECT rpm_limit, max_in_flight
    FROM ai_api_keys
    WHERE id = ?
  `,
  activeLeaseCount: `
    SELECT COUNT(*) AS active_count
    FROM ai_api_inflight_leases
    WHERE api_key_id = ?
      AND released_at IS NULL
      AND expires_at > ?
  `,
  incrementBucket: `
    INSERT INTO ai_rate_limit_buckets (api_key_id, window_start, request_count)
    VALUES (?, ?, 1)
    ON CONFLICT (api_key_id, window_start) DO UPDATE
    SET request_count = ai_rate_limit_buckets.request_count + 1
    WHERE ai_rate_limit_buckets.request_count < ?
    RETURNING request_count
  `,
  lease: `
    INSERT INTO ai_api_inflight_leases (request_id, api_key_id, expires_at)
    VALUES (?, ?, ?)
    ON CONFLICT (request_id) DO NOTHING
    RETURNING request_id
  `,
  // 併發下同 request_id 重入租約失敗時,把多加的視窗計數退回。
  decrementBucket: `
    UPDATE ai_rate_limit_buckets
    SET request_count = MAX(request_count - 1, 0)
    WHERE api_key_id = ? AND window_start = ?
  `,
  release: `
    UPDATE ai_api_inflight_leases
    SET released_at = ?
    WHERE request_id = ? AND released_at IS NULL
    RETURNING request_id
  `,
});

// 執行交易:query 介面可選提供 transaction(fn)。
async function withTransaction(query: any, fn: () => Promise<any>) {
  if (typeof query?.transaction === "function") {
    return query.transaction(fn);
  }
  return fn();
}

function minuteWindowStart(now: number): string {
  const ms = 60_000;
  return new Date(Math.floor(now / ms) * ms).toISOString();
}

export function createAkentrosApiLimitStore(query: any) {
  if (typeof query !== "function") throw new TypeError("A database query function is required.");
  return Object.freeze({
    async acquire({ apiKeyId, requestId, rpmLimit, maxInFlight, leaseTtlMs = 120_000 }: any) {
      const ttl = positiveInteger(leaseTtlMs, "leaseTtlMs", 600_000);
      positiveInteger(rpmLimit, "rpmLimit", 6000);
      positiveInteger(maxInFlight, "maxInFlight", 100);
      const expiresAt = new Date(Date.now() + ttl).toISOString();
      const windowStart = minuteWindowStart(Date.now());

      return withTransaction(query, async () => {
        const keyRows = await query(AKENTROS_API_LIMIT_SQL.acquireKey, [String(apiKeyId)]);
        const key: any = rows(keyRows)[0];
        if (!key) {
          throw new AkentrosError("This API key has exceeded its request rate limit.", {
            status: 429,
            type: "rate_limit_error",
            code: "rate_limit_exceeded",
            retryAfter: 60,
          });
        }

        const counts = await query(AKENTROS_API_LIMIT_SQL.activeLeaseCount, [
          String(apiKeyId),
          new Date().toISOString(),
        ]);
        const activeCount = Number(rows(counts)[0]?.active_count || 0);
        if (activeCount >= Number(key.max_in_flight)) {
          throw new AkentrosError("This API key has too many requests in flight.", {
            status: 429,
            type: "rate_limit_error",
            code: "max_in_flight_exceeded",
            retryAfter: 1,
          });
        }

        const bucket = await query(AKENTROS_API_LIMIT_SQL.incrementBucket, [
          String(apiKeyId),
          windowStart,
          Number(key.rpm_limit),
        ]);
        const bucketRow: any = rows(bucket)[0];
        if (!bucketRow) {
          throw new AkentrosError("This API key has exceeded its request rate limit.", {
            status: 429,
            type: "rate_limit_error",
            code: "rate_limit_exceeded",
            retryAfter: 60,
          });
        }

        const lease = await query(AKENTROS_API_LIMIT_SQL.lease, [
          String(requestId),
          String(apiKeyId),
          expiresAt,
        ]);
        const leaseRow: any = rows(lease)[0];
        if (!leaseRow) {
          await query(AKENTROS_API_LIMIT_SQL.decrementBucket, [String(apiKeyId), windowStart]);
          throw new AkentrosError("This API key has exceeded its request rate limit.", {
            status: 429,
            type: "rate_limit_error",
            code: "request_already_in_flight",
            retryAfter: 60,
          });
        }

        return { requestId: String(requestId), expiresAt };
      });
    },

    async release(requestId: string) {
      const result = await query(AKENTROS_API_LIMIT_SQL.release, [new Date().toISOString(), String(requestId)]);
      return Boolean(rows(result)[0]);
    },
  });
}
