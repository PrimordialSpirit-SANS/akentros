import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createBeaconDeveloperUsageStore } from "../src/developerUsage.ts";

function requestRow(overrides: any = {}) {
  return {
    id: "100",
    request_id: "req_abcdefgh12345678",
    user_id: "7",
    api_key_id: "9",
    key_name: "Production",
    public_model: "beacon/llama-3.2-1b-instruct",
    upstream_model: "owner/model",
    provider: "openrouter",
    status: "succeeded",
    input_tokens: "12",
    output_tokens: "5",
    total_tokens: "17",
    reserved_usd_micros: "4",
    charged_usd_micros: "2",
    refunded_usd_micros: "2",
    total_latency_ms: 420,
    first_token_ms: 80,
    error_code: null,
    pricing_revision: "2026-07-13.1",
    upstream_request_id: "opaque-upstream",
    created_at: "2026-07-12T01:00:00.000Z",
    finalized_at: "2026-07-12T01:00:01.000Z",
    ...overrides,
  };
}

test("usage summary keeps its stable shape without free-model quotas", async () => {
  let capturedSql = "";
  const store = createBeaconDeveloperUsageStore(async (sql: any) => {
    capturedSql = sql;
    return {
      rows: [
        {
          balance_usd_micros: "90000000",
          requests: "3",
          succeeded: "2",
          failed: "1",
          input_tokens: "100",
          output_tokens: "40",
          total_tokens: "140",
          charged_usd_micros: "7",
        },
      ],
    };
  });
  assert.deepEqual(await store.summary("7"), {
    balance_usd: "90.000000",
    requests: 3,
    succeeded: 2,
    failed: 1,
    input_tokens: 100,
    output_tokens: 40,
    total_tokens: 140,
    charged_usd: "0.000007",
    period_days: 30,
    free_model_quotas: {},
  });
  assert.match(capturedSql, /requests\.created_at >= \?/);
  assert.doesNotMatch(capturedSql, /INTERVAL|CURRENT_TIMESTAMP/);
  assert.doesNotMatch(capturedSql, /beacon-flash|beacon-lite/);
  assert.doesNotMatch(capturedSql, /ai_rate_limit_buckets/);
});

test("usage logs are cursor paginated and expose only Beacon-owned model metadata", async () => {
  let captured: any;
  const store = createBeaconDeveloperUsageStore(async (sql: any, params: any) => {
    captured = { sql, params };
    return {
      rows: [
        requestRow(),
        requestRow({ id: "99", request_id: "req_abcdefgh12345677", created_at: "2026-07-12T00:59:00.000Z" }),
      ],
    };
  });
  const page = await store.list("7", { limit: 1, status: "succeeded" });
  assert.equal(page.logs.length, 1);
  assert.equal(page.pagination.has_more, true);
  assert.equal(typeof page.pagination.next_cursor, "string");
  assert.equal(page.logs[0].request_id, "req_abcdefgh12345678");
  assert.equal(page.logs[0].requested_model, "beacon/llama-3.2-1b-instruct");
  assert.equal(page.logs[0].actual_model, "beacon/llama-3.2-1b-instruct");
  assert.equal(page.logs[0].provider, "beacon");
  assert.equal("prompt" in page.logs[0], false);
  assert.equal("completion" in page.logs[0], false);
  assert.doesNotMatch(JSON.stringify(page.logs[0]), /openrouter|owner\/model|opaque-upstream/i);
  assert.match(captured.sql, /requests\.user_id = \?/);
  assert.doesNotMatch(captured.sql, /prompt|completion/);

  await store.list("7", { cursor: page.pagination.next_cursor, limit: 1 });
  // created_at 即為毫秒精度 ISO 字串;row-value 比較避免同毫秒內漏頁。
  assert.match(captured.sql, /\(requests\.created_at, requests\.id\) < \(\?, \?\)/);
  assert.match(captured.sql, /ORDER BY requests\.created_at DESC, requests\.id DESC/);
});

test("usage query validation rejects malformed cursors, ranges, and statuses", async () => {
  const store = createBeaconDeveloperUsageStore(async () => ({ rows: [] }));
  await assert.rejects(store.list("7", { cursor: "not-a-cursor" }), /cursor is invalid/);
  await assert.rejects(store.list("7", { status: "made_up" }), /status is invalid/);
  await assert.rejects(
    store.list("7", { from: "2026-07-12", to: "2026-07-01" }),
    /from must not be after to/,
  );
});

test("request detail keeps a stable public shape without exposing routing audit", async () => {
  const store = createBeaconDeveloperUsageStore(async () => ({
    rows: [requestRow({ fallback_count: 2, error_code: "credential_rejected" })],
  }));
  const detail: any = await store.detail("7", "req_abcdefgh12345678");
  assert.equal(detail.actual_model, detail.requested_model);
  assert.equal(detail.provider, "beacon");
  assert.equal("fallback_count" in detail, false);
  assert.equal("upstream_request_id" in detail, false);
  assert.equal(detail.error_code, "service_unavailable");
  assert.equal(detail.pricing_revision, "2026-07-13.1");
  assert.equal("credential_id" in detail, false);
  assert.equal("prompt" in detail, false);
  assert.equal("completion" in detail, false);
  assert.doesNotMatch(JSON.stringify(detail), /openrouter|owner\/model|opaque-upstream|credential_rejected/i);
  await assert.rejects(store.detail("7", "bad-id"), /requestId is invalid/);
});

test("internal execution failures collapse to stable Beacon public error codes", async () => {
  const serviceUnavailableCodes = [
    "credential_rejected",
    "provider_quota_exhausted",
    "model_unavailable",
    "provider_unavailable",
    "provider_error",
    "invalid_provider_response",
    "embedded_provider_error",
    "midstream_provider_error",
    "no_provider_available",
    "attempt_audit_unavailable",
    "provider_configuration_error",
    "PROVIDER_SECRET_NOT_CONFIGURED",
    "rate_limited",
    "timeout",
  ];
  for (const internalCode of serviceUnavailableCodes) {
    const store = createBeaconDeveloperUsageStore(async () => ({
      rows: [requestRow({ error_code: internalCode })],
    }));
    const page = await store.list("7");
    assert.equal(page.logs[0].error_code, "service_unavailable", internalCode);
  }

  for (const [internalCode, publicCode] of [
    ["client_disconnected", "request_cancelled"],
    ["invalid_request", "invalid_request"],
  ]) {
    const store = createBeaconDeveloperUsageStore(async () => ({
      rows: [requestRow({ error_code: internalCode })],
    }));
    const page = await store.list("7");
    assert.equal(page.logs[0].error_code, publicCode, internalCode);
  }
});

test("native Beacon errors remain actionable in developer usage", async () => {
  const nativeCodes = [
    "invalid_api_key",
    "insufficient_scope",
    "model_not_allowed",
    "insufficient_balance",
    "free_quota_exceeded",
    "rate_limit_exceeded",
    "max_in_flight_exceeded",
  ];
  for (const nativeCode of nativeCodes) {
    const store = createBeaconDeveloperUsageStore(async () => ({
      rows: [requestRow({ error_code: nativeCode })],
    }));
    const page = await store.list("7");
    assert.equal(page.logs[0].error_code, nativeCode);
  }
});

test("Hono usage adapter uses the shared store", () => {
  const worker = readFileSync(new URL("../../../apps/gateway/src/utils/aiUsage.ts", import.meta.url), "utf8");
  assert.match(worker, /createBeaconDeveloperUsageStore/);
  assert.match(worker, /ensureAiSchema/);
  assert.doesNotMatch(worker, /SELECT|prompt|completion/);
});
