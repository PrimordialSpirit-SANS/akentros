import assert from "node:assert/strict";
import test from "node:test";
import {
  createAkentrosInferenceRuntime,
  prepareAkentrosChatRequest,
  prepareAkentrosEmbeddingsRequest,
} from "../src/inference.ts";
import { requireProviderPool } from "../src/providers.ts";

function aiKey(overrides: any = {}) {
  return {
    id: "17",
    model_allowlist: [],
    spend_limit_usd_micros: null,
    user: { id: "23" },
    ...overrides,
  };
}

function embeddingsBody(overrides: any = {}) {
  return {
    model: "akentros/text-embedding-3-small",
    input: "hello Akentros",
    ...overrides,
  };
}

function embeddingsProviderResponse(overrides: any = {}) {
  return new Response(
    JSON.stringify({
      object: "list",
      data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] }, ...(overrides.extraItems || [])],
      usage: overrides.usage ?? { prompt_tokens: 12, total_tokens: 12 },
      ...overrides.topLevel,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function openRouterClaim() {
  return {
    leaseId: "lease-test",
    requestId: "req_test",
    credentialId: "openrouter-primary",
    provider: "openrouter",
    poolId: "openrouter-production",
    expiresAt: "2030-01-01T00:00:00.000Z",
    secrets: { api_key: "provider-secret" },
    pool: requireProviderPool("openrouter-production"),
  };
}

function fakeBilling() {
  const calls: any[] = [];
  return {
    calls,
    reserve: async (reservation: any) => {
      calls.push(["reserve", reservation]);
      return { requestId: reservation.requestId, status: "reserved", idempotentReplay: false };
    },
    markDispatched: async (requestId: any) => calls.push(["dispatch", requestId]),
    settle: async (input: any) => {
      calls.push(["settle", input]);
      return { requestId: input.requestId, status: "succeeded" };
    },
    refund: async (input: any) => calls.push(["refund", input]),
    markNeedsReconciliation: async (input: any) => calls.push(["reconcile", input]),
  };
}

// 定價文件中的 embeddings 模型路由指向 openai-production;測試改以 openrouter
// pool 執行(fetch 已 stub,僅驗證 URL 與請求體組裝),與 chat 測試同手法。
function withOpenRouterRoute(prepared: any) {
  prepared.routes = [
    {
      route_id: "embeddings-test",
      provider: "openrouter",
      credential_pool: "openrouter-production",
      upstream_model: "owner/private-embedding",
      timeout_ms: 1000,
    },
  ];
  return prepared;
}

test("embeddings preparation validates fields, capabilities, and limits", async () => {
  await assert.rejects(
    prepareAkentrosEmbeddingsRequest({ body: embeddingsBody({ temperature: 1 }), aiKey: aiKey() }),
    (error: any) => error.code === "unsupported_parameter",
  );
  await assert.rejects(
    prepareAkentrosEmbeddingsRequest({ body: embeddingsBody({ input: "" }), aiKey: aiKey() }),
    (error: any) => error.status === 400 && error.param === "input.0",
  );
  await assert.rejects(
    prepareAkentrosEmbeddingsRequest({ body: embeddingsBody({ input: [[]] }), aiKey: aiKey() }),
    (error: any) => error.status === 400 && error.param === "input.0",
  );
  await assert.rejects(
    prepareAkentrosEmbeddingsRequest({ body: embeddingsBody({ dimensions: 0 }), aiKey: aiKey() }),
    (error: any) => error.status === 400 && error.param === "dimensions",
  );
  await assert.rejects(
    prepareAkentrosEmbeddingsRequest({
      body: embeddingsBody({ encoding_format: "binary" }),
      aiKey: aiKey(),
    }),
    (error: any) => error.status === 400 && error.param === "encoding_format",
  );
  await assert.rejects(
    prepareAkentrosEmbeddingsRequest({ body: embeddingsBody({ model: "akentros/unknown" }), aiKey: aiKey() }),
    (error: any) => error.status === 404 && error.code === "model_not_found",
  );
  // chat 模型不得走 embeddings;embeddings 模型不得走 chat。
  await assert.rejects(
    prepareAkentrosEmbeddingsRequest({
      body: embeddingsBody({ model: "akentros/gpt-6-astra" }),
      aiKey: aiKey(),
    }),
    (error: any) => error.code === "unsupported_feature",
  );
  await assert.rejects(
    prepareAkentrosChatRequest({
      body: { model: "akentros/text-embedding-3-small", messages: [{ role: "user", content: "hi" }] },
      aiKey: aiKey(),
    }),
    (error: any) => error.code === "unsupported_feature",
  );
  await assert.rejects(
    prepareAkentrosEmbeddingsRequest({
      body: embeddingsBody(),
      aiKey: aiKey({ model_allowlist: ["akentros/gpt-6-astra"] }),
    }),
    (error: any) => error.code === "model_not_allowed",
  );
});

test("embeddings preparation reserves input-only cost and stamps the embeddings endpoint", async () => {
  const prepared = await prepareAkentrosEmbeddingsRequest({
    body: embeddingsBody({ dimensions: 512, encoding_format: "base64" }),
    aiKey: aiKey({ spend_limit_usd_micros: 500 }),
  });
  assert.equal(prepared.endpoint, "embeddings");
  assert.equal(prepared.reservation.endpoint, "embeddings");
  assert.equal(prepared.reservation.stream, false);
  assert.deepEqual(prepared.body, {
    model: "akentros/text-embedding-3-small",
    input: ["hello Akentros"],
    dimensions: 512,
    encoding_format: "base64",
  });
  // 輸出單價為 0:保留額僅由輸入估計決定,且受 minimum_charge_usd 夾制。
  assert.equal(prepared.reservation.reservedCostMicros, 100);
  // 超過金鑰 spend limit 的保留額必須被擋下。
  await assert.rejects(
    prepareAkentrosEmbeddingsRequest({
      body: embeddingsBody(),
      aiKey: aiKey({ spend_limit_usd_micros: 10 }),
    }),
    (error: any) => error.code === "spend_limit_exceeded",
  );
});

test("embeddings runtime dispatches to the upstream embeddings endpoint and settles output-free usage", async () => {
  const prepared = withOpenRouterRoute(
    await prepareAkentrosEmbeddingsRequest({ body: embeddingsBody(), aiKey: aiKey() }),
  );
  const billing = fakeBilling();
  let upstreamUrl = "";
  let upstreamBody: any;
  const runtime = createAkentrosInferenceRuntime({
    billing,
    claimCredential: async () => openRouterClaim(),
    releaseCredential: async () => {},
    fetchImpl: async (url: any, init: any) => {
      upstreamUrl = String(url);
      upstreamBody = JSON.parse(init.body);
      return embeddingsProviderResponse();
    },
  });

  const result = await runtime.executeJson(prepared);
  assert.ok(upstreamUrl.endsWith("/embeddings"), `unexpected upstream URL: ${upstreamUrl}`);
  assert.equal(upstreamBody.model, "owner/private-embedding");
  assert.deepEqual(upstreamBody.input, ["hello Akentros"]);
  assert.equal(result.body.object, "list");
  assert.equal(result.body.model, "akentros/text-embedding-3-small");
  assert.equal(result.body.data[0].object, "embedding");
  assert.deepEqual(result.body.data[0].embedding, [0.1, 0.2, 0.3]);
  assert.deepEqual(result.body.usage, { prompt_tokens: 12, total_tokens: 12 });
  const settle = billing.calls.find(([name]: any) => name === "settle");
  assert.ok(settle, "settlement is required");
  assert.equal(settle[1].inputTokens, 12);
  assert.equal(settle[1].outputTokens, 0);
  assert.equal(settle[1].usageSource, "provider");
  // 12 tokens × $0.02/M = 1 micro,受 minimum_charge_usd = 100 micros 夾制。
  assert.equal(settle[1].actualCostMicros, 100);
});

test("embeddings base64 vectors and missing usage settle conservatively", async () => {
  const prepared = withOpenRouterRoute(
    await prepareAkentrosEmbeddingsRequest({
      body: embeddingsBody({ encoding_format: "base64" }),
      aiKey: aiKey(),
    }),
  );
  const billing = fakeBilling();
  const runtime = createAkentrosInferenceRuntime({
    billing,
    claimCredential: async () => openRouterClaim(),
    releaseCredential: async () => {},
    fetchImpl: async () =>
      embeddingsProviderResponse({
        topLevel: {
          data: [{ object: "embedding", index: 0, embedding: "aGVsbG8=" }],
          usage: null,
        },
      }),
  });
  const result = await runtime.executeJson(prepared);
  assert.equal(typeof result.body.data[0].embedding, "string");
  assert.equal(result.body.data[0].embedding, "aGVsbG8=");
  assert.equal(result.body.usage.prompt_tokens, prepared.estimatedInputTokens);
  const settle = billing.calls.find(([name]: any) => name === "settle");
  assert.equal(settle[1].usageSource, "estimated");
  assert.equal(settle[1].outputTokens, 0);
});
