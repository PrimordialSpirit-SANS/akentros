function rows(result: any): any[] {
  return Array.isArray(result?.rows) ? result.rows : [];
}

// SQLite 方言:finish 的「更新 attempt + 成功時回寫 ai_requests」由
// transaction(fn) 保證原子性;時間由呼叫端綁定。
export const BEACON_PROVIDER_ATTEMPT_SQL = Object.freeze({
  start: `
    INSERT INTO ai_provider_attempts (
      ai_request_id, request_id, attempt_number, provider, pool_id,
      credential_id, route_id, upstream_model, status, started_at
    )
    SELECT requests.id, requests.request_id, ?, ?, ?,
           ?, ?, ?, 'started', ?
    FROM ai_requests AS requests
    WHERE requests.request_id = ?
    ON CONFLICT (ai_request_id, attempt_number) DO UPDATE SET
      provider = EXCLUDED.provider,
      pool_id = EXCLUDED.pool_id,
      credential_id = EXCLUDED.credential_id,
      route_id = EXCLUDED.route_id,
      upstream_model = EXCLUDED.upstream_model
    RETURNING id, ai_request_id, request_id, attempt_number
  `,
  finishAttempt: `
    UPDATE ai_provider_attempts
    SET status = ?,
        http_status = ?,
        error_category = ?,
        upstream_request_id = ?,
        latency_ms = ?,
        finished_at = ?
    WHERE id = ? AND finished_at IS NULL
    RETURNING id, ai_request_id, request_id, attempt_number, status,
              provider, pool_id, route_id, upstream_model, upstream_request_id
  `,
  attachToRequest: `
    UPDATE ai_requests
    SET provider = ?, upstream_model = ?, route_id = ?, upstream_request_id = ?,
        updated_at = ?
    WHERE id = ?
  `,
});

// 執行交易:query 介面可選提供 transaction(fn)。
async function withTransaction(query: any, fn: () => Promise<any>) {
  if (typeof query?.transaction === "function") {
    return query.transaction(fn);
  }
  return fn();
}

function positiveInteger(value: unknown, label: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new TypeError(`${label} must be a positive integer.`);
  return parsed;
}

function bounded(value: unknown, label: string, maximum: number, optional = false) {
  if (optional && (value === null || value === undefined || value === "")) return null;
  const normalized = typeof value === "string" ? value.trim() : String(value ?? "");
  if (!normalized || normalized.length > maximum) {
    throw new TypeError(`${label} must contain at most ${maximum} characters.`);
  }
  return normalized;
}

export function createBeaconProviderAttemptStore(query: any) {
  if (typeof query !== "function") throw new TypeError("A database query function is required.");
  return Object.freeze({
    async start({ requestId, attemptNumber, route, credentialId }: any) {
      const result = await query(BEACON_PROVIDER_ATTEMPT_SQL.start, [
        positiveInteger(attemptNumber, "attemptNumber"),
        bounded(route.provider, "route.provider", 40),
        bounded(route.credential_pool, "route.credential_pool", 120),
        bounded(credentialId, "credentialId", 160, true),
        bounded(route.route_id, "route.route_id", 120),
        bounded(route.upstream_model, "route.upstream_model", 240),
        new Date().toISOString(),
        bounded(requestId, "requestId", 80),
      ]);
      const row = rows(result)[0];
      return row
        ? { id: String(row.id), requestId: String(row.request_id), attemptNumber: Number(row.attempt_number) }
        : null;
    },

    async finish(
      attempt: any,
      { success, httpStatus = null, errorCategory = null, upstreamRequestId = null, latencyMs = null }: any,
    ) {
      if (!attempt?.id) return null;
      const latency = latencyMs === null ? null : Math.max(0, Math.round(Number(latencyMs)));
      const now = new Date().toISOString();
      return withTransaction(query, async () => {
        const finished = await query(BEACON_PROVIDER_ATTEMPT_SQL.finishAttempt, [
          success ? "succeeded" : "failed",
          httpStatus === null ? null : Number(httpStatus),
          bounded(errorCategory, "errorCategory", 80, true),
          bounded(upstreamRequestId, "upstreamRequestId", 200, true),
          Number.isSafeInteger(latency) ? latency : null,
          now,
          String(attempt.id),
        ]);
        const row: any = rows(finished)[0];
        if (!row) return null;
        if (success) {
          await query(BEACON_PROVIDER_ATTEMPT_SQL.attachToRequest, [
            row.provider,
            row.upstream_model,
            row.route_id,
            row.upstream_request_id,
            now,
            row.ai_request_id,
          ]);
        }
        return row;
      });
    },
  });
}
