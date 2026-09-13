import { PROVIDER_POOLS, resolveProviderCredential } from "./providers.ts";

function rows(result: any): any[] {
  return Array.isArray(result?.rows) ? result.rows : [];
}

function requiredString(value: unknown, label: string, maxLength = 160) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > maxLength) {
    throw new TypeError(`${label} must be a non-empty string of at most ${maxLength} characters.`);
  }
  return normalized;
}

function positiveInteger(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new TypeError(`${label} must be a positive integer no greater than ${maximum}.`);
  }
  return parsed;
}

function normalizeExcludedCredentialIds(value: any): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) && !(value instanceof Set)) {
    throw new TypeError("excludedCredentialIds must be an array or Set.");
  }
  return [
    ...new Set(
      [...value].map((credentialId: any) => requiredString(credentialId, "excludedCredentialIds item", 160)),
    ),
  ];
}

function normalizeClaim(row: any) {
  if (!row) return null;
  return {
    leaseId: String(row.lease_id),
    requestId: String(row.request_id),
    credentialId: String(row.credential_id),
    provider: String(row.provider),
    poolId: String(row.pool_id),
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

// SQLite 方言:排他選取以「交易 + 單連線序列化」取代 PG 的
// FOR UPDATE SKIP LOCKED;時間與排除清單由呼叫端綁定
// (json_each 取代 PG 陣列參數)。
export const BEACON_PROVIDER_POOL_SQL = Object.freeze({
  syncCredential: `
    INSERT INTO ai_provider_credentials (
      credential_id, provider, pool_id, enabled, weight, max_in_flight,
      state, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, 'healthy', ?)
    ON CONFLICT (credential_id) DO UPDATE SET
      provider = EXCLUDED.provider,
      pool_id = EXCLUDED.pool_id,
      enabled = EXCLUDED.enabled,
      weight = EXCLUDED.weight,
      max_in_flight = EXCLUDED.max_in_flight,
      updated_at = EXCLUDED.updated_at
    RETURNING credential_id
  `,
  disableMissingCredentials: `
    UPDATE ai_provider_credentials
    SET enabled = 0, updated_at = ?
    WHERE credential_id NOT IN (SELECT value FROM json_each(?))
    RETURNING credential_id
  `,
  candidateCredentials: `
    SELECT credentials.*,
           (
             SELECT COUNT(*)
             FROM ai_provider_credential_leases AS leases
             WHERE leases.credential_id = credentials.credential_id
               AND leases.released_at IS NULL
               AND leases.expires_at > ?
           ) AS active_leases
    FROM ai_provider_credentials AS credentials
    WHERE credentials.pool_id = ?
      AND credentials.credential_id NOT IN (SELECT value FROM json_each(?))
      AND credentials.enabled = TRUE
      AND credentials.state IN ('healthy', 'degraded', 'cooldown')
      AND (credentials.cooldown_until IS NULL OR credentials.cooldown_until <= ?)
      AND (
        SELECT COUNT(*)
        FROM ai_provider_credential_leases AS leases
        WHERE leases.credential_id = credentials.credential_id
          AND leases.released_at IS NULL
          AND leases.expires_at > ?
      ) < credentials.max_in_flight
    ORDER BY
      credentials.selection_count * 1.0 / MAX(credentials.weight, 1),
      credentials.last_selected_at,
      credentials.credential_id
    LIMIT 1
  `,
  markClaimed: `
    UPDATE ai_provider_credentials
    SET in_flight = ?,
        selection_count = selection_count + 1,
        last_selected_at = ?,
        lease_expires_at = ?,
        updated_at = ?
    WHERE credential_id = ?
  `,
  insertLease: `
    INSERT INTO ai_provider_credential_leases (
      lease_id, request_id, credential_id, expires_at
    )
    VALUES (?, ?, ?, ?)
    RETURNING lease_id, request_id, credential_id, expires_at
  `,
  markReleased: `
    UPDATE ai_provider_credential_leases
    SET released_at = ?
    WHERE lease_id = ? AND released_at IS NULL
    RETURNING credential_id
  `,
  credentialState: `
    SELECT in_flight, consecutive_failures, ewma_latency_ms, last_success_at, last_failure_at
    FROM ai_provider_credentials
    WHERE credential_id = ?
  `,
  applyRelease: `
    UPDATE ai_provider_credentials
    SET in_flight = ?,
        successful_requests = successful_requests + ?,
        failed_requests = failed_requests + ?,
        consecutive_failures = ?,
        state = ?,
        cooldown_until = ?,
        lease_expires_at = NULL,
        last_success_at = ?,
        last_failure_at = ?,
        last_error_code = ?,
        ewma_latency_ms = ?,
        updated_at = ?
    WHERE credential_id = ?
    RETURNING credential_id, state, consecutive_failures, cooldown_until
  `,
});

export async function syncBeaconProviderCredentials(query: any, config: any = PROVIDER_POOLS) {
  if (typeof query !== "function") throw new TypeError("A database query function is required.");
  const credentialIds: string[] = [];
  for (const [poolId, pool] of Object.entries(config.pools || {}) as Array<[string, any]>) {
    for (const credential of pool.credentials || []) {
      credentialIds.push(credential.credential_id);
      await query(BEACON_PROVIDER_POOL_SQL.syncCredential, [
        credential.credential_id,
        pool.provider,
        poolId,
        pool.enabled === true && credential.enabled === true,
        positiveInteger(credential.weight, "credential.weight", 10_000),
        positiveInteger(credential.max_in_flight, "credential.max_in_flight", 10_000),
        new Date().toISOString(),
      ]);
    }
  }
  if (credentialIds.length) {
    await query(BEACON_PROVIDER_POOL_SQL.disableMissingCredentials, [
      new Date().toISOString(),
      JSON.stringify(credentialIds),
    ]);
  }
  return { credentialIds };
}

// 執行交易:query 介面可選提供 transaction(fn)。
async function withTransaction(query: any, fn: () => Promise<any>) {
  if (typeof query?.transaction === "function") {
    return query.transaction(fn);
  }
  return fn();
}

export function createBeaconProviderPoolStore(query: any) {
  if (typeof query !== "function") throw new TypeError("A database query function is required.");
  return Object.freeze({
    sync: (config: any) => syncBeaconProviderCredentials(query, config),

    async claim({
      poolId,
      requestId,
      leaseTtlMs,
      excludedCredentialIds = [],
      leaseId = globalThis.crypto.randomUUID(),
    }: any) {
      const normalizedPool = requiredString(poolId, "poolId", 120);
      const normalizedRequest = requiredString(requestId, "requestId", 80);
      const normalizedExcludedCredentialIds = normalizeExcludedCredentialIds(excludedCredentialIds);
      const ttl = positiveInteger(leaseTtlMs, "leaseTtlMs", 600_000);
      const expiresAt = new Date(Date.now() + ttl).toISOString();
      const now = new Date().toISOString();
      const excludedJson = JSON.stringify(normalizedExcludedCredentialIds);

      return withTransaction(query, async () => {
        const candidates = await query(BEACON_PROVIDER_POOL_SQL.candidateCredentials, [
          now,
          normalizedPool,
          excludedJson,
          now,
          now,
        ]);
        const candidate: any = rows(candidates)[0];
        if (!candidate) return null;

        await query(BEACON_PROVIDER_POOL_SQL.markClaimed, [
          Number(candidate.active_leases) + 1,
          now,
          expiresAt,
          now,
          candidate.credential_id,
        ]);

        const lease = await query(BEACON_PROVIDER_POOL_SQL.insertLease, [
          leaseId,
          normalizedRequest,
          candidate.credential_id,
          expiresAt,
        ]);
        const leaseRow: any = rows(lease)[0];
        if (!leaseRow) return null;

        return normalizeClaim({
          ...leaseRow,
          provider: candidate.provider,
          pool_id: candidate.pool_id,
        });
      });
    },

    async release({
      leaseId,
      success,
      category = null,
      latencyMs = null,
      retryAfter = null,
      selection,
    }: any) {
      const normalizedLease = requiredString(leaseId, "leaseId", 80);
      const latency =
        latencyMs === null || latencyMs === undefined
          ? null
          : positiveInteger(Math.max(1, Number(latencyMs)), "latencyMs", 86_400_000);
      const ok = Boolean(success);
      const normalizedCategory = ok
        ? null
        : requiredString(String(category || "provider_error"), "category", 100);
      const baseCooldownMs = positiveInteger(selection?.base_cooldown_ms || 5_000, "base_cooldown_ms");
      const maxCooldownMs = positiveInteger(selection?.max_cooldown_ms || 300_000, "max_cooldown_ms");
      const retryAfterMs =
        Number.isFinite(Number(retryAfter)) && Number(retryAfter) >= 0
          ? Math.ceil(Number(retryAfter) * 1000)
          : 0;
      const credentialFailure =
        normalizedCategory === "credential_rejected" ||
        normalizedCategory === "provider_quota_exhausted" ||
        normalizedCategory === "provider_configuration_error";
      const minimumCooldownMs = Math.min(maxCooldownMs, credentialFailure ? maxCooldownMs : retryAfterMs);

      return withTransaction(query, async () => {
        const now = new Date().toISOString();
        const released = await query(BEACON_PROVIDER_POOL_SQL.markReleased, [now, normalizedLease]);
        const releasedRow: any = rows(released)[0];
        if (!releasedRow) return null;
        const credentialId = String(releasedRow.credential_id);

        const stateRows = await query(BEACON_PROVIDER_POOL_SQL.credentialState, [credentialId]);
        const state: any = rows(stateRows)[0];
        if (!state) return null;

        const consecutiveFailures = ok ? 0 : Math.min(Number(state.consecutive_failures || 0) + 1, 1_000_000);
        // 指數退避:base * 2^failures,夾在 [minimum, max];與原單語句版一致。
        const backoffMs = Math.min(baseCooldownMs * 2 ** Math.min(consecutiveFailures, 16), maxCooldownMs);
        const cooldownMs = ok ? 0 : Math.max(minimumCooldownMs, backoffMs);
        const cooldownUntil = ok ? null : new Date(Date.now() + cooldownMs).toISOString();
        const oldEwma =
          state.ewma_latency_ms === null || state.ewma_latency_ms === undefined
            ? null
            : Number(state.ewma_latency_ms);
        const ewma = latency === null ? oldEwma : oldEwma === null ? latency : oldEwma * 0.8 + latency * 0.2;

        const applied = await query(BEACON_PROVIDER_POOL_SQL.applyRelease, [
          Math.max(Number(state.in_flight || 0) - 1, 0),
          ok ? 1 : 0,
          ok ? 0 : 1,
          consecutiveFailures,
          ok ? "healthy" : credentialFailure || consecutiveFailures >= 3 ? "cooldown" : "degraded",
          cooldownUntil,
          ok ? now : (state.last_success_at ?? null),
          ok ? (state.last_failure_at ?? null) : now,
          ok ? null : normalizedCategory,
          ewma,
          now,
          credentialId,
        ]);
        return rows(applied)[0] || null;
      });
    },
  });
}

export async function claimConfiguredBeaconProviderCredential({
  store,
  pool,
  poolId,
  requestId,
  environment,
  excludedCredentialIds = [],
  leaseTtlMs = pool?.selection?.lease_ttl_ms,
  resolveSecrets = true,
}: any) {
  if (!store || typeof store.claim !== "function" || typeof store.release !== "function") {
    throw new TypeError("A provider pool store with claim and release functions is required.");
  }
  const excluded = new Set(normalizeExcludedCredentialIds(excludedCredentialIds));
  let resolutionError: any = null;

  while (true) {
    const claim = await store.claim({
      poolId,
      requestId,
      leaseTtlMs,
      excludedCredentialIds: [...excluded],
    });
    if (!claim) {
      if (resolutionError) throw resolutionError;
      return null;
    }

    excluded.add(claim.credentialId);
    const configured = pool.credentials.find((item: any) => item.credential_id === claim.credentialId);
    if (!configured) {
      await store.release({
        leaseId: claim.leaseId,
        success: false,
        category: "provider_configuration_error",
        selection: pool.selection,
      });
      continue;
    }

    try {
      if (!resolveSecrets) {
        return {
          ...claim,
          provider: pool.provider,
          secrets: Object.freeze({}),
          pool,
        };
      }
      return {
        ...claim,
        ...resolveProviderCredential(pool, configured, environment),
        pool,
      };
    } catch (error: any) {
      await store.release({
        leaseId: claim.leaseId,
        success: false,
        category: "provider_configuration_error",
        selection: pool.selection,
      });
      resolutionError = error;
    }
  }
}
