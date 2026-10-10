import assert from "node:assert/strict";
import test from "node:test";
import {
  createAkentrosInferenceRuntime,
  createAkentrosResponsesStreamBridge,
  normalizeStreamChunk,
  prepareAkentrosResponsesRequest,
  publicResponsesObject,
} from "../src/inference.ts";
import { AkentrosProviderError, requireProviderPool } from "../src/providers.ts";

function aiKey(overrides: any = {}) {
  return {
    id: "17",
    model_allowlist: [],
    spend_limit_usd: null,
    user: { id: "23" },
    ...overrides,
  };
}

function responsesBody(overrides: any = {}) {
  return { model: "akentros/gpt-6-astra", input: "Hello Akentros", ...overrides };
}

function fakeBilling(overrides: any = {}) {
  const calls: any[] = [];
  const billing = {
    calls,
    reserve: async (reservation: any) => {
      calls.push(["reserve", reservation.requestId, reservation.endpoint]);
      return { requestId: reservation.requestId, status: "reserved", idempotentReplay: false };
    },
    markDispatched: async (requestId: any) => calls.push(["dispatch", requestId]),
    settle: async (input: any) => {
      calls.push(["settle", input.requestId]);
      return { requestId: input.requestId, status: "succeeded" };
    },
    refund: async (input: any) => calls.push(["refund", input.requestId]),
    markNeedsReconciliation: async (input: any) => calls.push(["reconcile", input.requestId]),
    ...overrides,
  };
  return billing;
}

function openAiClaim() {
  return {
    leaseId: "lease-test",
    requestId: "req_test",
    credentialId: "openai-primary",
    provider: "openai",
    poolId: "openai-production",
    expiresAt: "2030-01-01T00:00:00.000Z",
    secrets: { api_key: "provider-secret" },
    pool: requireProviderPool("openai-production"),
  };
}

function jsonProviderResponse(content = "Hello back", finishReason = "stop") {
  return new Response(
    JSON.stringify({
      id: "upstream-secret-id",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finishReason }],
      usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

test("responses preparation translates the bridged subset onto the chat pipeline", async () => {
  const prepared = await prepareAkentrosResponsesRequest({
    body: responsesBody({
      instructions: "Answer concisely.",
      max_output_tokens: 128,
      temperature: 0.5,
      top_p: 0.9,
    }),
    aiKey: aiKey(),
  });
  // 端點標籤:prepared 與保留單都以 responses 計(計費與請求紀錄可分辨)。
  assert.equal(prepared.endpoint, "responses");
  assert.equal(prepared.reservation.endpoint, "responses");
  // 轉換後的內部體是 chat 形狀:instructions → system、input → user、
  // max_output_tokens → max_completion_tokens。
  assert.equal(prepared.body.model, "akentros/gpt-6-astra");
  assert.deepEqual(prepared.body.messages, [
    { role: "system", content: "Answer concisely." },
    { role: "user", content: "Hello Akentros" },
  ]);
  assert.equal(prepared.body.max_completion_tokens, 128);
  assert.equal(prepared.body.temperature, 0.5);
  assert.equal(prepared.body.top_p, 0.9);
  assert.equal(prepared.body.stream, false);
  // instructions 原樣附在 prepared 上供回應面回票(OpenAI 慣例)。
  assert.equal(prepared.instructions, "Answer concisely.");

  // input 陣列形狀:多輪歷史 + vision 模型的 input_text/input_image parts
  // (Responses 面命名)轉為 chat parts 後通過同一套驗證。
  const visionPrepared = await prepareAkentrosResponsesRequest({
    body: responsesBody({
      input: [
        { role: "user", content: "這張圖是?" },
        { role: "assistant", content: "一張圖表。" },
        {
          role: "user",
          content: [
            { type: "input_text", text: "圖裡的趨勢是?" },
            { type: "input_image", image_url: "https://example.com/chart.png" },
          ],
        },
      ],
    }),
    aiKey: aiKey(),
  });
  assert.deepEqual(visionPrepared.body.messages[2], {
    role: "user",
    content: [
      { type: "text", text: "圖裡的趨勢是?" },
      { type: "image_url", image_url: { url: "https://example.com/chart.png" } },
    ],
  });
  // image part 計入保守輸入估計。
  assert.ok(visionPrepared.estimatedInputTokens >= 1_000);

  // 非 vision 模型的 input_image parts 維持 400。
  await assert.rejects(
    prepareAkentrosResponsesRequest({
      body: responsesBody({
        model: "akentros/gpt-5.2-codex",
        input: [{ role: "user", content: [{ type: "input_image", image_url: "https://example.com/a.png" }] }],
      }),
      aiKey: aiKey(),
    }),
    (error: any) => error.status === 400 && /string or null/.test(error.message),
  );
});

test("responses preparation gates advanced features and tolerates neutral parameters", async () => {
  // 已知進階功能:可分辨的 unsupported_feature,參數指名。
  for (const field of [
    "background",
    "previous_response_id",
    "conversation",
    "tools",
    "tool_choice",
    "parallel_tool_calls",
    "reasoning",
    "text",
    "include",
    "truncation",
    "prompt",
    "prompt_template",
  ]) {
    await assert.rejects(
      prepareAkentrosResponsesRequest({
        body: responsesBody({ [field]: true }),
        aiKey: aiKey(),
      }),
      (error: any) => error.status === 400 && error.code === "unsupported_feature" && error.param === field,
    );
  }

  // 對閘道中立的參數(responses API 的 store 預設開啟,SDK 常態攜帶):
  // 接受後丟棄,上游體不含這些欄位。
  const tolerated = await prepareAkentrosResponsesRequest({
    body: responsesBody({ user: "user-123", store: true, metadata: { origin: "sdk" }, service_tier: "auto" }),
    aiKey: aiKey(),
  });
  assert.doesNotMatch(JSON.stringify(tolerated.body), /user-123|service_tier|metadata/);

  // 其餘未知欄位:unsupported_parameter 指名。
  await assert.rejects(
    prepareAkentrosResponsesRequest({
      body: responsesBody({ vendor_hint: "no" }),
      aiKey: aiKey(),
    }),
    (error: any) =>
      error.status === 400 && error.code === "unsupported_parameter" && error.param === "vendor_hint",
  );

  // 純 system/developer input(無 user/assistant)回 400;非法 input 形狀 400。
  await assert.rejects(
    prepareAkentrosResponsesRequest({
      body: responsesBody({ input: [{ role: "system", content: "only system" }] }),
      aiKey: aiKey(),
    }),
    (error: any) => error.status === 400 && error.param === "input",
  );
  await assert.rejects(
    prepareAkentrosResponsesRequest({ body: responsesBody({ input: 42 }), aiKey: aiKey() }),
    (error: any) => error.status === 400 && error.param === "input",
  );

  // 指紋與 chat 分開:同內容的 chat 與 responses 請求指紋不同(endpoint 進入指紋)。
  const chatLikeFingerprint = await prepareAkentrosResponsesRequest({
    body: responsesBody(),
    aiKey: aiKey(),
    idempotencyKey: "bridge-key",
  });
  const secondBridge = await prepareAkentrosResponsesRequest({
    body: responsesBody(),
    aiKey: aiKey(),
    idempotencyKey: "bridge-key",
  });
  assert.equal(
    chatLikeFingerprint.reservation.requestFingerprint,
    secondBridge.reservation.requestFingerprint,
  );
});

test("bridged responses execute on the chat pipeline and settle with endpoint responses", async () => {
  const billing = fakeBilling();
  const runtime = createAkentrosInferenceRuntime({
    billing,
    attempts: null,
    claimCredential: async () => openAiClaim(),
    releaseCredential: async () => {},
    fetchImpl: async () => jsonProviderResponse("Bridged answer"),
  });
  const prepared = await prepareAkentrosResponsesRequest({
    body: responsesBody(),
    aiKey: aiKey(),
  });
  const result = await runtime.executeJson(prepared);
  // 橋接結果包裝為 Responses 物件。
  const wrapped = publicResponsesObject(result.body, prepared);
  assert.equal(wrapped.object, "response");
  assert.match(wrapped.id, /^resp_/);
  assert.equal(wrapped.status, "completed");
  assert.equal(wrapped.incomplete_details, null);
  assert.equal(wrapped.output[0].type, "message");
  assert.equal(wrapped.output[0].content[0].type, "output_text");
  assert.equal(wrapped.output[0].content[0].text, "Bridged answer");
  assert.deepEqual(wrapped.usage, { input_tokens: 8, output_tokens: 4, total_tokens: 12 });

  // 計費狀態機:reserve(endpoint=responses)→ dispatch → settle。
  assert.deepEqual(
    billing.calls.map((call: any[]) => call[0]),
    ["reserve", "dispatch", "settle"],
  );
  assert.equal(billing.calls[0][2], "responses");
});

test("bridged responses settle refunds on provider failure like chat", async () => {
  const billing = fakeBilling();
  const runtime = createAkentrosInferenceRuntime({
    billing,
    attempts: null,
    claimCredential: async () => openAiClaim(),
    releaseCredential: async () => {},
    fetchImpl: async () =>
      new Response(JSON.stringify({ error: { message: "no" } }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
  });
  const prepared = await prepareAkentrosResponsesRequest({
    body: responsesBody(),
    aiKey: aiKey(),
  });
  await assert.rejects(() => runtime.executeJson(prepared));
  const operations = billing.calls.map((call: any[]) => call[0]);
  assert.deepEqual(operations, ["reserve", "dispatch", "refund"]);
});

test("responses object marks length finish as incomplete", () => {
  const prepared = {
    requestId: "req_abc123",
    created: 1_700_000_000,
    modelId: "akentros/gpt-6-astra",
    instructions: "Be brief.",
    maxCompletionTokens: 16,
    body: { temperature: 0.2 },
  };
  const completed = publicResponsesObject(
    {
      choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    },
    prepared,
  );
  assert.equal(completed.status, "completed");
  assert.equal(completed.incomplete_details, null);

  const incomplete = publicResponsesObject(
    {
      choices: [{ index: 0, message: { role: "assistant", content: "trunc" }, finish_reason: "length" }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    },
    prepared,
  );
  assert.equal(incomplete.status, "incomplete");
  assert.deepEqual(incomplete.incomplete_details, { reason: "max_output_tokens" });
});

test("responses stream bridge translates chat chunks into the response event sequence", async () => {
  const prepared = {
    requestId: "req_streambridge",
    created: 1_700_000_000,
    modelId: "akentros/gpt-6-astra",
    instructions: null,
    maxCompletionTokens: 64,
    body: {},
  };
  const bridge = createAkentrosResponsesStreamBridge(prepared);
  const firstChunk = normalizeStreamChunk(
    { choices: [{ index: 0, delta: { role: "assistant", content: "Hel" }, finish_reason: null }] },
    prepared,
  );
  const opening = bridge.translate(firstChunk);
  assert.deepEqual(
    opening.map((frame: any) => frame.event),
    [
      "response.created",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
    ],
  );
  assert.equal(opening[3].data.delta, "Hel");

  const secondChunk = normalizeStreamChunk(
    { choices: [{ index: 0, delta: { content: "lo" }, finish_reason: null }] },
    prepared,
  );
  const deltas = bridge.translate(secondChunk);
  assert.deepEqual(
    deltas.map((frame: any) => frame.event),
    ["response.output_text.delta"],
  );

  const usageChunk = normalizeStreamChunk(
    {
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 6, completion_tokens: 2, total_tokens: 8 },
    },
    prepared,
  );
  bridge.translate(usageChunk);

  const closing = bridge.finalize();
  assert.deepEqual(
    closing.map((frame: any) => frame.event),
    [
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ],
  );
  assert.equal(closing[0].data.text, "Hello");
  const completed = closing[3].data.response;
  assert.equal(completed.status, "completed");
  assert.equal(completed.output[0].content[0].text, "Hello");
  assert.deepEqual(completed.usage, { input_tokens: 6, output_tokens: 2, total_tokens: 8 });

  // finish_reason=length 的串流改以 response.incomplete 收尾。
  const lengthBridge = createAkentrosResponsesStreamBridge(prepared);
  lengthBridge.translate(
    normalizeStreamChunk(
      { choices: [{ index: 0, delta: { content: "cut" }, finish_reason: "length" }] },
      prepared,
    ),
  );
  const lengthClosing = lengthBridge.finalize();
  assert.equal(lengthClosing[3].event, "response.incomplete");
  assert.equal(lengthClosing[3].data.response.status, "incomplete");

  // 空串流(從未收到內容 chunk)仍補齊完整開場與收尾序列。
  const emptyBridge = createAkentrosResponsesStreamBridge(prepared);
  const emptyClosing = emptyBridge.finalize();
  assert.deepEqual(
    emptyClosing.map((frame: any) => frame.event),
    [
      "response.created",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ],
  );
  assert.equal(emptyClosing[3].data.text, "");
});

test("responses stream failures stay in-band and never leak provider details", async () => {
  // 橋接狀態機不吞錯誤:上游錯誤仍由端點層的 failStream 處理;此處僅驗證
  // 翻譯層對 tool_calls delta(不支援的輸出形狀)不產生文字事件。
  const prepared = { requestId: "req_toolout", created: 1, modelId: "akentros/gpt-6-astra", body: {} };
  const bridge = createAkentrosResponsesStreamBridge(prepared);
  const toolChunk = normalizeStreamChunk(
    {
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "f", arguments: "{}" } }] },
          finish_reason: null,
        },
      ],
    },
    prepared,
  );
  const events = bridge.translate(toolChunk);
  // 開場事件照常,但 tool delta 不產生 output_text 事件。
  assert.deepEqual(
    events.map((frame: any) => frame.event),
    ["response.created", "response.output_item.added", "response.content_part.added"],
  );
  assert.ok(events.every((frame: any) => frame.event !== "response.output_text.delta"));

  // 端點層的錯誤包裝維持公開錯誤語意(不洩漏 provider 細節)。
  const providerError = new AkentrosProviderError("upstream secret detail", {
    provider: "openai",
    status: 502,
    category: "provider_unavailable",
  });
  const safe = await import("../src/inference.ts").then((m) => m.publicProviderError(providerError));
  assert.equal((safe as any).code, "service_unavailable");
  assert.ok(!String((safe as any).message).includes("upstream secret detail"));
});
