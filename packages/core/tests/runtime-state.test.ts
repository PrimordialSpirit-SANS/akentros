import assert from "node:assert/strict";
import test from "node:test";
import { AKENTROS_API_LIMIT_SQL, createAkentrosApiLimitStore } from "../src/apiLimits.ts";
import { createAkentrosInferenceRuntime, prepareAkentrosChatRequest } from "../src/inference.ts";
import {
  AKENTROS_PROVIDER_ATTEMPT_SQL,
  createAkentrosProviderAttemptStore,
} from "../src/providerAttempts.ts";
import {
  AKENTROS_PROVIDER_POOL_SQL,
  claimConfiguredAkentrosProviderCredential,
  createAkentrosProviderPoolStore,
  syncAkentrosProviderCredentials,
} from "../src/providerPool.ts";
import { requireProviderPool } from "../src/providers.ts";
import { migrateAkentrosSchema } from "../src/schemaMigration.ts";
import { createSqliteTestDb } from "./sqliteTestDb.ts";

async function runtimeFixture() {
  const { query } = createSqliteTestDb();
  await migrateAkentrosSchema(query);
  await query(
    `INSERT INTO users (username, email, password_hash) VALUES ('pool-tester', 'pool@test.local', 'x')`,
  );
  await query(
    `INSERT INTO ai_api_keys (user_id, name, key_prefix, key_suffix, key_digest, rpm_limit, max_in_flight)
     VALUES (1, 'limit key', 'test-prefix', 'ff', ?, 60, 4)`,
    ["c".repeat(64)],
  );
  return { query, apiKeyId: "1" };
}

test("API admission contract: bucket upsert, lease insert, bound parameters", () => {
  assert.match(AKENTROS_API_LIMIT_SQL.acquireKey, /FROM ai_api_keys/);
  assert.match(AKENTROS_API_LIMIT_SQL.activeLeaseCount, /released_at IS NULL/);
  assert.match(AKENTROS_API_LIMIT_SQL.incrementBucket, /request_count \+ 1/);
  assert.match(AKENTROS_API_LIMIT_SQL.incrementBucket, /request_count < \?/);
  assert.match(AKENTROS_API_LIMIT_SQL.lease, /INSERT INTO ai_api_inflight_leases/);
  assert.match(AKENTROS_API_LIMIT_SQL.release, /released_at IS NULL/);
});

test("API admission serializes each key and atomically applies RPM and inflight limits", async () => {
  const { query, apiKeyId } = await runtimeFixture();
  const store = createAkentrosApiLimitStore(query);

  const lease = await store.acquire({
    apiKeyId,
    requestId: "req_limit",
    rpmLimit: 60,
    maxInFlight: 4,
  });
  assert.equal(lease.requestId, "req_limit");

  // 同 request_id 重入 → 拒絕,且視窗計數回退。
  await assert.rejects(
    store.acquire({ apiKeyId, requestId: "req_limit", rpmLimit: 60, maxInFlight: 4 }),
    (error: any) => error.status === 429 && error.code === "request_already_in_flight",
  );
  const bucket = await query(`SELECT request_count FROM ai_rate_limit_buckets WHERE api_key_id = 1`);
  assert.equal(Number(bucket.rows[0].request_count), 1);

  assert.equal(await store.release("req_limit"), true);

  // max_in_flight 邊界:4 個租約後第五個請求被拒。
  for (let index = 0; index < 4; index += 1) {
    await store.acquire({ apiKeyId, requestId: `req_fly_${index}`, rpmLimit: 60, maxInFlight: 4 });
  }
  await assert.rejects(
    store.acquire({ apiKeyId, requestId: "req_fly_5", rpmLimit: 60, maxInFlight: 4 }),
    (error: any) => error.status === 429 && error.code === "max_in_flight_exceeded" && error.retryAfter === 1,
  );
});

test("API admission RPM limit blocks beyond the configured rate", async () => {
  const { query } = await runtimeFixture();
  await query(`UPDATE ai_api_keys SET rpm_limit = 2 WHERE id = 1`);
  const store = createAkentrosApiLimitStore(query);
  await store.acquire({ apiKeyId: "1", requestId: "req_r1", rpmLimit: 2, maxInFlight: 4 });
  await store.acquire({ apiKeyId: "1", requestId: "req_r2", rpmLimit: 2, maxInFlight: 4 });
  await assert.rejects(
    store.acquire({ apiKeyId: "1", requestId: "req_r3", rpmLimit: 2, maxInFlight: 4 }),
    (error: any) => error.status === 429 && error.code === "rate_limit_exceeded" && error.retryAfter === 60,
  );
});

test("provider pool is lease-based, weighted, capacity bounded, and secret-free", async () => {
  assert.match(AKENTROS_PROVIDER_POOL_SQL.candidateCredentials, /active_leases/);
  assert.match(AKENTROS_PROVIDER_POOL_SQL.candidateCredentials, /< credentials\.max_in_flight/);
  assert.match(
    AKENTROS_PROVIDER_POOL_SQL.candidateCredentials,
    /NOT IN \(SELECT value FROM json_each\(\?\)\)/,
  );
  assert.match(
    AKENTROS_PROVIDER_POOL_SQL.candidateCredentials,
    /selection_count \* 1\.0 \/ MAX\(credentials\.weight, 1\)/,
  );
  assert.match(AKENTROS_PROVIDER_POOL_SQL.markReleased, /released_at IS NULL/);

  const calls: any[] = [];
  await syncAkentrosProviderCredentials(async (sql: any, params: any) => {
    calls.push({ sql, params });
    return { rows: [] };
  });
  assert.equal(
    calls.filter(({ sql }: any) => sql.includes("INSERT INTO ai_provider_credentials")).length,
    37,
  );
  assert.equal(
    calls.some(({ params }: any) => params.some((value: any) => String(value).includes("API_KEY"))),
    false,
  );
});

test("provider pool claim respects in-flight capacity and excluded credentials", async () => {
  const { query } = createSqliteTestDb();
  await migrateAkentrosSchema(query);
  const store = createAkentrosProviderPoolStore(query);
  await (store as any).sync();

  const claim: any = await store.claim({
    poolId: "openrouter-production",
    requestId: "req_pool",
    leaseTtlMs: 90_000,
    excludedCredentialIds: ["openrouter-secondary"],
    leaseId: "00000000-0000-4000-8000-000000000001",
  });
  assert.equal(claim.credentialId, "openrouter-primary");
  assert.equal(claim.poolId, "openrouter-production");

  // 同 request_id 再 claim → 排除所有 credential 後回 null。
  const empty = await store.claim({
    poolId: "openrouter-production",
    requestId: "req_other",
    leaseTtlMs: 90_000,
    excludedCredentialIds: ["openrouter-primary", "openrouter-secondary"],
  });
  assert.equal(empty, null);
});

test("provider pool claim and circuit release use one shared database state", async () => {
  const { query } = createSqliteTestDb();
  await migrateAkentrosSchema(query);
  const store = createAkentrosProviderPoolStore(query);
  await (store as any).sync();

  const claim: any = await store.claim({
    poolId: "openrouter-production",
    requestId: "req_pool",
    leaseTtlMs: 90_000,
    leaseId: "00000000-0000-4000-8000-000000000001",
  });
  const released = await store.release({
    leaseId: claim.leaseId,
    success: false,
    category: "rate_limited",
    selection: { base_cooldown_ms: 5000, max_cooldown_ms: 300000 },
  });
  // rate_limited 不屬於憑證類錯誤且首次失敗 → degraded(與原 PG 版 CASE 語義一致)。
  assert.equal(released.state, "degraded");
  assert.equal(Number(released.consecutive_failures), 1);
  assert.notEqual(released.cooldown_until, null);

  const credential = await query(
    `SELECT in_flight, state FROM ai_provider_credentials WHERE credential_id = 'openrouter-primary'`,
  );
  assert.equal(Number(credential.rows[0].in_flight), 0);
});

test("provider pool releases unusable claims and advances to the next healthy credential", async () => {
  const pool = {
    provider: "openrouter",
    selection: {
      lease_ttl_ms: 90_000,
      base_cooldown_ms: 5_000,
      max_cooldown_ms: 300_000,
    },
    credentials: [
      {
        credential_id: "missing-secret",
        secret_refs: { api_key: "MISSING_PROVIDER_KEY" },
      },
      {
        credential_id: "healthy",
        secret_refs: { api_key: "HEALTHY_PROVIDER_KEY" },
      },
    ],
  };
  const candidates = ["caller-excluded", "stale-config", "missing-secret", "healthy"];
  const claimCalls: any[] = [];
  const releases: any[] = [];
  const store = {
    async claim(input: any) {
      claimCalls.push(input);
      const credentialId = candidates.find((candidate) => !input.excludedCredentialIds.includes(candidate));
      if (!credentialId) return null;
      return {
        leaseId: `lease-${credentialId}`,
        requestId: input.requestId,
        credentialId,
        provider: pool.provider,
        poolId: input.poolId,
        expiresAt: "2030-01-01T00:00:00.000Z",
      };
    },
    async release(input: any) {
      releases.push(input);
      return { credential_id: input.leaseId.replace("lease-", "") };
    },
  };

  const claim = await claimConfiguredAkentrosProviderCredential({
    store,
    pool,
    poolId: "openrouter-production",
    requestId: "req_resilient_pool",
    environment: { HEALTHY_PROVIDER_KEY: "healthy-secret" },
    excludedCredentialIds: ["caller-excluded"],
  });

  assert.ok(claim);
  assert.equal(claim.credentialId, "healthy");
  assert.equal(claim.secrets.api_key, "healthy-secret");
  assert.deepEqual(
    claimCalls.map((call) => call.excludedCredentialIds),
    [
      ["caller-excluded"],
      ["caller-excluded", "stale-config"],
      ["caller-excluded", "stale-config", "missing-secret"],
    ],
  );
  assert.deepEqual(
    releases.map(({ leaseId, success, category }: any) => ({ leaseId, success, category })),
    [
      {
        leaseId: "lease-stale-config",
        success: false,
        category: "provider_configuration_error",
      },
      {
        leaseId: "lease-missing-secret",
        success: false,
        category: "provider_configuration_error",
      },
    ],
  );
});

test("native provider binding claims capacity without requiring REST secrets", async () => {
  const pool = {
    provider: "cloudflare-workers-ai",
    selection: { lease_ttl_ms: 90_000 },
    credentials: [
      {
        credential_id: "native-capacity-slot",
        secret_refs: {
          api_token: "MISSING_API_TOKEN",
          account_id: "MISSING_ACCOUNT_ID",
        },
      },
    ],
  };
  const store = {
    claim: async (input: any) => ({
      leaseId: "lease-native",
      requestId: input.requestId,
      credentialId: "native-capacity-slot",
      provider: pool.provider,
      poolId: input.poolId,
      expiresAt: "2030-01-01T00:00:00.000Z",
    }),
    release: async () => {
      throw new Error("A valid native claim must not be released during resolution.");
    },
  };

  const claim = await claimConfiguredAkentrosProviderCredential({
    store,
    pool,
    poolId: "cloudflare-workers-ai-production",
    requestId: "req_native_binding",
    environment: {},
    resolveSecrets: false,
  });

  assert.ok(claim);
  assert.equal(claim.credentialId, "native-capacity-slot");
  assert.equal(claim.provider, "cloudflare-workers-ai");
  assert.deepEqual(claim.secrets, {});
  assert.equal(claim.pool, pool);
});

test("provider attempt audit stores opaque routing metadata and attaches successes", async () => {
  assert.match(AKENTROS_PROVIDER_ATTEMPT_SQL.start, /INSERT INTO ai_provider_attempts/);
  assert.match(AKENTROS_PROVIDER_ATTEMPT_SQL.finishAttempt, /finished_at IS NULL/);
  assert.doesNotMatch(AKENTROS_PROVIDER_ATTEMPT_SQL.start, /prompt|completion|api_key|api_token/);

  const { query } = createSqliteTestDb();
  await migrateAkentrosSchema(query);
  await query(
    `INSERT INTO ai_requests (request_id, user_id, api_key_id, request_fingerprint, public_model, pricing_revision, pricing_snapshot)
     VALUES ('req_attempt', 1, 1, ?, 'akentros-test-model', 'pricing-v1', '{}')`,
    ["b".repeat(64)],
  );
  const store = createAkentrosProviderAttemptStore(query);

  const attempt: any = await store.start({
    requestId: "req_attempt",
    attemptNumber: 1,
    credentialId: "openrouter-primary",
    route: {
      provider: "openrouter",
      credential_pool: "openrouter-production",
      route_id: "route-test",
      upstream_model: "owner/model",
    },
  });
  assert.equal(attempt.attemptNumber, 1);

  const finished = await store.finish(attempt, {
    success: true,
    httpStatus: 200,
    upstreamRequestId: "upstream-opaque",
    latencyMs: 42,
  });
  assert.equal(finished.status, "succeeded");

  // 成功的 attempt 回寫請求列的供應商欄位(provider 仍是對外的 'akentros')。
  const request = await query(
    `SELECT upstream_model, upstream_request_id FROM ai_requests WHERE request_id = 'req_attempt'`,
  );
  assert.equal(request.rows[0].upstream_model, "owner/model");
  assert.equal(request.rows[0].upstream_request_id, "upstream-opaque");
});

test("lease bookkeeping failure after provider success never repeats inference", async () => {
  const prepared = await prepareAkentrosChatRequest({
    body: {
      model: "akentros/qwen-3.8-27b",
      messages: [{ role: "user", content: "hello" }],
    },
    aiKey: { id: "1", user: { id: "2" }, model_allowlist: [], spend_limit_usd_micros: null },
  });
  prepared.routes = [
    {
      route_id: "one",
      provider: "openrouter",
      credential_pool: "openrouter-production",
      upstream_model: "owner/model",
      timeout_ms: 1000,
    },
    {
      route_id: "two",
      provider: "openrouter",
      credential_pool: "openrouter-production",
      upstream_model: "owner/model-2",
      timeout_ms: 1000,
    },
  ];
  let providerCalls = 0;
  const billingCalls: any[] = [];
  const runtime = createAkentrosInferenceRuntime({
    billing: {
      reserve: async () => ({ requestId: prepared.requestId, idempotentReplay: false }),
      markDispatched: async () => {},
      settle: async () => billingCalls.push("settle"),
      refund: async () => billingCalls.push("refund"),
      markNeedsReconciliation: async () => billingCalls.push("reconcile"),
    },
    claimCredential: async () => ({
      leaseId: "lease-test",
      requestId: prepared.requestId,
      credentialId: "openrouter-primary",
      provider: "openrouter",
      poolId: "openrouter-production",
      expiresAt: "2030-01-01T00:00:00.000Z",
      secrets: { api_key: "secret" },
      pool: requireProviderPool("openrouter-production"),
    }),
    releaseCredential: async () => {
      throw new Error("lease database unavailable");
    },
    fetchImpl: async () => {
      providerCalls += 1;
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "ok" } }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  await runtime.executeJson(prepared);
  assert.equal(providerCalls, 1);
  assert.deepEqual(billingCalls, ["settle"]);
});
