import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(
  new URL("../../../apps/console/src/lib/akentros/api/akentrosPublicContract.ts", import.meta.url),
  "utf8",
);
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const contractModuleUrl = `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`;
const {
  hasAkentrosErrorEnvelope,
  normalizeAkentrosError,
  normalizeAkentrosLogsPage,
  normalizeAkentrosRequestDetail,
  normalizeAkentrosStreamChunk,
  normalizeAkentrosUsageSummary,
} = await import(contractModuleUrl);

test("frontend replaces vendor HTTP errors with stable Akentros errors", () => {
  const error = normalizeAkentrosError(
    {
      error: {
        message: "OpenRouter rejected the upstream request with 403",
        code: "provider_unavailable",
        metadata: { provider: "openrouter", upstream_status: 403 },
      },
    },
    { status: 403, context: "inference" },
  );

  assert.deepEqual(error, {
    code: "service_unavailable",
    message: "Akentros 暫時無法完成此請求，請稍後再試。",
  });
  assert.doesNotMatch(JSON.stringify(error), /openrouter|upstream|provider|403/i);

  const forbidden = normalizeAkentrosError(
    { message: "Forbidden" },
    {
      status: 403,
      context: "developer",
    },
  );
  assert.equal(forbidden.code, "access_denied");
  assert.doesNotMatch(forbidden.message, /forbidden|403/i);
});

test("frontend preserves native Akentros error codes without trusting response messages", () => {
  const error = normalizeAkentrosError(
    {
      error: {
        message: "untrusted response text",
        code: "model_not_allowed",
      },
    },
    { status: 403, context: "inference" },
  );

  assert.equal(error.code, "model_not_allowed");
  assert.equal(error.message, "此 API 金鑰未開放指定的 Akentros 模型。");
  assert.equal(hasAkentrosErrorEnvelope({ error: { code: "model_not_allowed" } }), true);
});

test("frontend usage normalization discards stale routing metadata", () => {
  const staleLog = {
    request_id: "req_public",
    created_at: "2026-07-15T00:00:00.000Z",
    api_key_id: "9",
    key_name: "Production",
    requested_model: "akentros/qwen-3.8-27b",
    actual_model: "owner/vendor-model",
    provider: "openrouter",
    status: "succeeded",
    input_tokens: 5,
    output_tokens: 2,
    total_tokens: 7,
    reserved_usd_micros: 3,
    charged_usd_micros: 2,
    refunded_usd_micros: 1,
    latency_ms: 100,
    error_code: "provider_unavailable",
    route_id: "vendor-route",
    upstream_request_id: "opaque-upstream-id",
  };
  const page = normalizeAkentrosLogsPage({
    logs: [staleLog],
    pagination: { next_cursor: null, has_more: false },
  });
  const log = page.logs[0];

  assert.equal(log.actual_model, log.requested_model);
  assert.equal(log.provider, "akentros");
  assert.equal(log.error_code, "request_failed");
  assert.doesNotMatch(JSON.stringify(log), /openrouter|owner\/vendor-model|vendor-route|opaque-upstream-id/i);

  const detail = normalizeAkentrosRequestDetail({
    ...staleLog,
    fallback_count: 4,
    upstream_request_id: "opaque-upstream-id",
  });
  assert.equal("upstream_request_id" in detail, false);
  assert.equal(detail.fallback_count, 0);
  assert.doesNotMatch(JSON.stringify(detail), /openrouter|upstream-id|vendor-route/i);
});

test("frontend usage summary normalizes monthly free-model quotas", () => {
  const summary = normalizeAkentrosUsageSummary({
    free_model_quotas: {
      "akentros/akentros-flash": { used: "16", limit: "5000" },
      "akentros/akentros-lite": { used: 2, limit: 500 },
      invalid: "discard me",
    },
  });

  assert.deepEqual(summary.free_model_quotas, {
    "akentros/akentros-flash": { used: 16, limit: 5000 },
    "akentros/akentros-lite": { used: 2, limit: 500 },
  });
});

test("frontend stream normalization keeps reasoning but drops vendor fields", () => {
  const chunk = normalizeAkentrosStreamChunk({
    id: "upstream-id",
    model: "owner/vendor-model",
    provider: "vendor-name",
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          content: "答案",
          reasoning_content: "推理",
          provider_trace: "secret-route",
        },
        finish_reason: null,
        provider_metadata: { route: "secret-route" },
      },
    ],
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
  });

  assert.equal(chunk.choices[0].delta.content, "答案");
  assert.equal(chunk.choices[0].delta.reasoning_content, "推理");
  assert.deepEqual(chunk.usage, {
    prompt_tokens: 4,
    completion_tokens: 2,
    total_tokens: 6,
  });
  assert.doesNotMatch(JSON.stringify(chunk), /vendor|upstream|secret-route|provider/i);
});
