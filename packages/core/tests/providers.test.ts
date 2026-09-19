import assert from "node:assert/strict";
import test from "node:test";
import {
  BeaconProviderError,
  buildProviderRequest,
  invokeProviderRoute,
  invokeWithProviderFallback,
  normalizeProviderUsage,
  requireProviderPool,
  resolveProviderCredential,
} from "../src/providers.ts";
import { parseSseStream } from "../src/sse.ts";

const openRouterRoute = {
  route_id: "test-openrouter",
  provider: "openrouter",
  credential_pool: "openrouter-production",
  upstream_model: "meta-llama/test",
  timeout_ms: 1000,
};

function openRouterCredential() {
  return {
    credentialId: "openrouter-primary",
    provider: "openrouter",
    secrets: { api_key: "secret-test-key" },
  };
}

function jsonResponse(payload: any, init: any = {}) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json", ...init.headers },
    ...init,
  });
}

test("OpenAI-compatible providers use bearer auth and preserve tool definitions", () => {
  for (const [provider, poolId] of [
    ["openrouter", "openrouter-production"],
    ["hugging-face", "hugging-face-production"],
    ["qwencloud", "qwencloud-production"],
    ["openai", "openai-production"],
    ["google", "google-production"],
    ["xai", "xai-production"],
    ["groq", "groq-production"],
    ["mistral", "mistral-production"],
    ["deepseek", "deepseek-production"],
    ["together", "together-production"],
    ["fireworks", "fireworks-production"],
    ["cerebras", "cerebras-production"],
    ["perplexity", "perplexity-production"],
    ["cohere", "cohere-production"],
    ["moonshot", "moonshot-production"],
    ["zhipu", "zhipu-production"],
    ["minimax", "minimax-production"],
    ["nvidia", "nvidia-production"],
    ["deepinfra", "deepinfra-production"],
    ["sambanova", "sambanova-production"],
    ["lambda", "lambda-production"],
    ["friendli", "friendli-production"],
    ["baichuan", "baichuan-production"],
    ["stepfun", "stepfun-production"],
    ["hunyuan", "hunyuan-production"],
    ["spark", "spark-production"],
    ["ernie", "ernie-production"],
    ["ai21", "ai21-production"],
    ["amazon-bedrock", "amazon-bedrock-production"],
    ["scaleway", "scaleway-production"],
    ["ovhcloud", "ovhcloud-production"],
  ]) {
    const pool = requireProviderPool(poolId);
    const credential = {
      credentialId: "test",
      provider,
      secrets: { api_key: "secret-test-key" },
    };
    const request = buildProviderRequest({
      route: { ...openRouterRoute, provider, upstream_model: "owner/model" },
      pool,
      credential,
      body: {
        model: "beacon/public",
        messages: [{ role: "user", content: "hello" }],
        tools: [
          {
            type: "function",
            function: { name: "lookup", parameters: { type: "object", properties: {} } },
          },
        ],
      },
    });
    assert.match(request.url, /\/chat\/completions$/);
    assert.equal(request.init.headers.authorization, "Bearer secret-test-key");
    assert.equal(request.init.redirect, "manual");
    const requestBody = JSON.parse(request.init.body);
    assert.equal(requestBody.model, "owner/model");
    assert.equal(requestBody.tools[0].function.name, "lookup");
    assert.equal(requestBody.tools[0].function.parameters.type, "object");
    assert.doesNotMatch(request.init.body, /beacon\/public/);
  }
});

test("OpenAI-compatible providers translate output limits and stream_options per provider quirks", () => {
  const cases = [
    // [provider, poolId, expected output-limit field, expects stream_options]
    ["openai", "openai-production", "max_completion_tokens", true],
    ["google", "google-production", "max_completion_tokens", true],
    ["deepseek", "deepseek-production", "max_tokens", true],
    ["groq", "groq-production", "max_tokens", true],
    ["perplexity", "perplexity-production", "max_tokens", false],
    ["cohere", "cohere-production", "max_tokens", false],
    ["amazon-bedrock", "amazon-bedrock-production", "max_tokens", false],
  ] as const;
  for (const [provider, poolId, outputLimitField, expectsStreamOptions] of cases) {
    const pool = requireProviderPool(poolId);
    const credential = { credentialId: "test", provider, secrets: { api_key: "secret-test-key" } };
    for (const stream of [false, true]) {
      const request = buildProviderRequest({
        route: { provider, upstream_model: "owner/model" },
        pool,
        credential,
        body: {
          model: "beacon/public",
          messages: [{ role: "user", content: "hello" }],
          max_completion_tokens: 64,
          stream,
          ...(stream ? { stream_options: { include_usage: true } } : {}),
        },
      });
      const payload = JSON.parse(request.init.body);
      assert.equal(payload[outputLimitField], 64, `${provider} output-limit field`);
      assert.equal("max_completion_tokens" in payload, outputLimitField === "max_completion_tokens");
      if (stream) {
        assert.deepEqual(
          payload.stream_options,
          expectsStreamOptions ? { include_usage: true } : undefined,
          `${provider} stream_options`,
        );
      }
    }
  }
});

test("Anthropic requests use the Messages API with translated system, tools, and output limits", () => {
  const pool = requireProviderPool("anthropic-production");
  assert.throws(() => resolveProviderCredential(pool, pool.credentials[0], {}), {
    code: "PROVIDER_SECRET_NOT_CONFIGURED",
  });
  const credential = resolveProviderCredential(pool, pool.credentials[0], {
    ANTHROPIC_API_KEY_1: "anthropic-test-secret",
  });
  const request = buildProviderRequest({
    route: { provider: "anthropic", upstream_model: "claude-test-model" },
    pool,
    credential,
    body: {
      model: "beacon/claude-test",
      messages: [
        { role: "system", content: "Be concise." },
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "lookup", arguments: '{"q":"beacon"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: '{"answer":"ok"}' },
        { role: "user", content: "thanks" },
      ],
      max_completion_tokens: 64,
      temperature: 0.5,
      top_p: 0.9,
      stop: ["END"],
      tools: [
        {
          type: "function",
          function: {
            name: "lookup",
            description: "Look things up.",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      tool_choice: "auto",
      seed: 1,
    },
  });
  assert.equal(request.url, "https://api.anthropic.com/v1/messages");
  assert.equal(request.init.headers["x-api-key"], "anthropic-test-secret");
  assert.equal(request.init.headers["anthropic-version"], "2023-06-01");
  assert.equal("authorization" in request.init.headers, false);
  const payload = JSON.parse(request.init.body);
  assert.equal(payload.model, "claude-test-model");
  assert.equal(payload.system, "Be concise.");
  assert.equal(payload.max_tokens, 64);
  assert.equal(payload.temperature, 0.5);
  assert.equal("top_p" in payload, false);
  assert.deepEqual(payload.stop_sequences, ["END"]);
  assert.deepEqual(payload.tools, [
    {
      name: "lookup",
      description: "Look things up.",
      input_schema: { type: "object", properties: {} },
    },
  ]);
  assert.equal(payload.tool_choice, undefined);
  assert.equal("seed" in payload, false);
  assert.equal(payload.messages.length, 3);
  assert.deepEqual(payload.messages[0], { role: "user", content: [{ type: "text", text: "hello" }] });
  assert.deepEqual(payload.messages[1].role, "assistant");
  assert.deepEqual(payload.messages[1].content, [
    {
      type: "tool_use",
      id: "call_1",
      name: "lookup",
      input: { q: "beacon" },
    },
  ]);
  assert.deepEqual(payload.messages[2].role, "user");
  assert.deepEqual(payload.messages[2].content, [
    { type: "tool_result", tool_use_id: "call_1", content: '{"answer":"ok"}' },
    { type: "text", text: "thanks" },
  ]);
  assert.doesNotMatch(request.init.body, /anthropic-test-secret|beacon\/claude-test/);
});

test("Anthropic maps every OpenAI tool_choice mode to its Messages API equivalent", () => {
  const pool = requireProviderPool("anthropic-production");
  const credential = resolveProviderCredential(pool, pool.credentials[0], {
    ANTHROPIC_API_KEY_1: "anthropic-test-secret",
  });
  const tools = [
    {
      type: "function",
      function: { name: "lookup", parameters: { type: "object", properties: {} } },
    },
  ];
  const build = (tool_choice: unknown) =>
    JSON.parse(
      buildProviderRequest({
        route: { provider: "anthropic", upstream_model: "claude-test-model" },
        pool,
        credential,
        body: { messages: [{ role: "user", content: "hi" }], tools, tool_choice },
      }).init.body as string,
    );

  // "none" 必須阻止工具呼叫:舊版折成 undefined(= auto)會讓上游照樣
  // 呼叫工具。tools 參數仍須存在(歷史含 tool_use/tool_result 區塊時必備)。
  const none = build("none");
  assert.deepEqual(none.tool_choice, { type: "none" });
  assert.ok(Array.isArray(none.tools) && none.tools.length === 1);
  const required = build("required");
  assert.deepEqual(required.tool_choice, { type: "any" });
  const named = build({ type: "function", function: { name: "lookup" } });
  assert.deepEqual(named.tool_choice, { type: "tool", name: "lookup" });
});

test("Anthropic JSON responses are normalized into the OpenAI completion shape", async () => {
  const result = await invokeProviderRoute({
    route: { provider: "anthropic", upstream_model: "claude-test-model", timeout_ms: 1000 },
    pool: requireProviderPool("anthropic-production"),
    credential: { provider: "anthropic", secrets: { api_key: "anthropic-test-secret" } },
    body: { messages: [{ role: "user", content: "hello" }], max_completion_tokens: 64 },
    fetchImpl: async () =>
      jsonResponse(
        {
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "claude-test-model",
          content: [
            { type: "thinking", thinking: "thinking it through" },
            { type: "text", text: "hello back" },
          ],
          stop_reason: "end_turn",
          usage: { input_tokens: 4, output_tokens: 2 },
        },
        { headers: { "request-id": "anthropic-request" } },
      ),
  });
  assert.equal(result.payload.object, "chat.completion");
  assert.equal(result.payload.model, "claude-test-model");
  assert.equal(result.payload.choices[0].message.content, "hello back");
  assert.equal(result.payload.choices[0].message.reasoning, "thinking it through");
  assert.equal(result.payload.choices[0].finish_reason, "stop");
  assert.deepEqual(result.payload.usage, {
    prompt_tokens: 4,
    completion_tokens: 2,
    total_tokens: 6,
  });
  assert.equal(result.inputTokens, 4);
  assert.equal(result.outputTokens, 2);
  assert.equal(result.usageSource, "provider");
  assert.equal(result.upstreamRequestId, "anthropic-request");

  const toolResult = await invokeProviderRoute({
    route: { provider: "anthropic", upstream_model: "claude-test-model", timeout_ms: 1000 },
    pool: requireProviderPool("anthropic-production"),
    credential: { provider: "anthropic", secrets: { api_key: "anthropic-test-secret" } },
    body: { messages: [{ role: "user", content: "hello" }], max_completion_tokens: 64 },
    fetchImpl: async () =>
      jsonResponse({
        id: "msg_tools",
        type: "message",
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "lookup", input: { q: "beacon" } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
  });
  assert.equal(toolResult.payload.choices[0].finish_reason, "tool_calls");
  assert.deepEqual(toolResult.payload.choices[0].message.tool_calls, [
    {
      id: "toolu_1",
      type: "function",
      function: { name: "lookup", arguments: '{"q":"beacon"}' },
    },
  ]);
});

test("Anthropic invalid JSON responses are normalized without leaking a TypeError", async () => {
  await assert.rejects(
    invokeProviderRoute({
      route: { provider: "anthropic", upstream_model: "claude-test-model", timeout_ms: 1000 },
      pool: requireProviderPool("anthropic-production"),
      credential: { provider: "anthropic", secrets: { api_key: "anthropic-test-secret" } },
      body: { messages: [{ role: "user", content: "hello" }] },
      fetchImpl: async () => jsonResponse({ type: "unexpected" }),
    }),
    (error: any) =>
      error instanceof BeaconProviderError &&
      error.category === "invalid_provider_response" &&
      error.responseStarted === true &&
      error.usageUnknown === true,
  );
});

test("Anthropic SSE streams are converted to OpenAI chunks with a usage frame and DONE", async () => {
  const encoder = new TextEncoder();
  const anthropicStream = new ReadableStream({
    start(controller) {
      const events = [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":4}}}',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"he"}}',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"llo"}}',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
        'event: message_stop\ndata: {"type":"message_stop"}',
      ];
      for (const event of events) controller.enqueue(encoder.encode(`${event}\n\n`));
      controller.close();
    },
  });
  const result = await invokeProviderRoute({
    route: { provider: "anthropic", upstream_model: "claude-test-model", timeout_ms: 1000 },
    pool: requireProviderPool("anthropic-production"),
    credential: { provider: "anthropic", secrets: { api_key: "anthropic-test-secret" } },
    body: { messages: [{ role: "user", content: "hello" }], stream: true },
    fetchImpl: async () =>
      new Response(anthropicStream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
  });
  assert.equal(result.stream, true);
  const chunks: any[] = [];
  for await (const event of parseSseStream(result.response.body)) {
    if (event.data === "[DONE]") {
      chunks.push("[DONE]");
      break;
    }
    chunks.push(JSON.parse(event.data));
  }
  result.dispose();
  const deltas = chunks
    .filter((chunk) => chunk !== "[DONE]" && chunk.choices?.length > 0)
    .map((chunk) => chunk.choices[0].delta);
  assert.deepEqual(deltas[0], { role: "assistant" });
  assert.deepEqual(deltas[1], { content: "he" });
  assert.deepEqual(deltas[2], { content: "llo" });
  assert.deepEqual(deltas[3], { reasoning: "hmm" });
  const finishChunk = chunks.find(
    (chunk) => chunk !== "[DONE]" && chunk.choices?.length > 0 && chunk.choices[0].finish_reason !== null,
  );
  assert.equal(finishChunk.choices[0].finish_reason, "stop");
  const usageChunk = chunks.find((chunk) => chunk !== "[DONE]" && chunk.usage);
  assert.deepEqual(usageChunk.usage, {
    prompt_tokens: 4,
    completion_tokens: 2,
    total_tokens: 6,
  });
  assert.equal(chunks.at(-1), "[DONE]");
});

test("Anthropic tool-use streams surface tool call deltas and a tool_calls finish reason", async () => {
  const encoder = new TextEncoder();
  const anthropicStream = new ReadableStream({
    start(controller) {
      const events = [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_2","usage":{"input_tokens":9}}}',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"lookup"}}',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":"}}',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"beacon\\"}"}}',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}',
        'event: message_stop\ndata: {"type":"message_stop"}',
      ];
      for (const event of events) controller.enqueue(encoder.encode(`${event}\n\n`));
      controller.close();
    },
  });
  const result = await invokeProviderRoute({
    route: { provider: "anthropic", upstream_model: "claude-test-model", timeout_ms: 1000 },
    pool: requireProviderPool("anthropic-production"),
    credential: { provider: "anthropic", secrets: { api_key: "anthropic-test-secret" } },
    body: { messages: [{ role: "user", content: "hello" }], stream: true },
    fetchImpl: async () =>
      new Response(anthropicStream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
  });
  const chunks: any[] = [];
  for await (const event of parseSseStream(result.response.body)) {
    if (event.data === "[DONE]") break;
    chunks.push(JSON.parse(event.data));
  }
  result.dispose();
  const toolDeltas = chunks.flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls || []);
  assert.deepEqual(toolDeltas[0], {
    index: 0,
    id: "toolu_1",
    type: "function",
    function: { name: "lookup", arguments: "" },
  });
  assert.deepEqual(toolDeltas[1], { index: 0, function: { arguments: '{"q":' } });
  assert.deepEqual(toolDeltas[2], { index: 0, function: { arguments: '"beacon"}' } });
  const finishChunk = chunks.find(
    (chunk) => chunk.choices?.length > 0 && chunk.choices[0].finish_reason !== null,
  );
  assert.equal(finishChunk.choices[0].finish_reason, "tool_calls");
});

test("Anthropic midstream errors surface as usage-unknown provider failures", async () => {
  const encoder = new TextEncoder();
  const anthropicStream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
        ),
      );
      controller.close();
    },
  });
  const result = await invokeProviderRoute({
    route: { provider: "anthropic", upstream_model: "claude-test-model", timeout_ms: 1000 },
    pool: requireProviderPool("anthropic-production"),
    credential: { provider: "anthropic", secrets: { api_key: "anthropic-test-secret" } },
    body: { messages: [{ role: "user", content: "hello" }], stream: true },
    fetchImpl: async () =>
      new Response(anthropicStream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
  });
  await assert.rejects(
    async () => {
      for await (const _event of parseSseStream(result.response.body)) {
        // The converted stream must fail before yielding any chunk.
      }
    },
    (error: any) =>
      error instanceof BeaconProviderError &&
      error.category === "midstream_provider_error" &&
      error.responseStarted === true &&
      error.usageUnknown === true,
  );
  result.dispose();
});

test("QwenCloud uses the configured endpoint, translates output limits and requests streaming usage", () => {
  const pool = requireProviderPool("qwencloud-production");
  assert.throws(() => resolveProviderCredential(pool, pool.credentials[0], {}), {
    code: "PROVIDER_SECRET_NOT_CONFIGURED",
  });
  const credential = resolveProviderCredential(pool, pool.credentials[0], {
    QWENCLOUD_API_KEY_1: "qwen-test-secret",
  });
  for (const stream of [false, true]) {
    const request = buildProviderRequest({
      pool,
      credential,
      route: { provider: "qwencloud", upstream_model: "qwen3.8-max" },
      body: {
        model: "beacon/qwen-3.8-max",
        messages: [{ role: "user", content: "hello" }],
        max_completion_tokens: 64,
        stream,
      },
    });
    assert.equal(request.url, "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions");
    assert.equal(request.init.headers.authorization, "Bearer qwen-test-secret");
    assert.equal(request.init.redirect, "manual");
    const payload = JSON.parse(request.init.body);
    assert.equal(payload.model, "qwen3.8-max");
    assert.equal(payload.max_tokens, 64);
    assert.equal("max_completion_tokens" in payload, false);
    assert.equal(payload.stream, stream);
    assert.deepEqual(payload.stream_options, stream ? { include_usage: true } : undefined);
    assert.doesNotMatch(request.init.body, /qwen-test-secret|beacon\/qwen/);
  }
});

test("QwenCloud normalizes JSON usage and DashScope request IDs through the shared adapter", async () => {
  const result = await invokeProviderRoute({
    route: { provider: "qwencloud", upstream_model: "glm-5.2", timeout_ms: 1000 },
    pool: requireProviderPool("qwencloud-production"),
    credential: { provider: "qwencloud", secrets: { api_key: "qwen-test-secret" } },
    body: { messages: [{ role: "user", content: "hello" }], max_completion_tokens: 64 },
    fetchImpl: async () =>
      jsonResponse(
        {
          id: "completion-id",
          choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
        },
        { headers: { "x-dashscope-request-id": "dashscope-request" } },
      ),
  });
  assert.equal(result.payload.choices[0].message.content, "OK");
  assert.equal(result.inputTokens, 4);
  assert.equal(result.outputTokens, 2);
  assert.equal(result.usageSource, "provider");
  assert.equal(result.upstreamRequestId, "dashscope-request");
});

test("reasoning token details are a sanitized subset of output usage and never added twice", () => {
  const usage = { prompt_tokens: 10, completion_tokens: 100, total_tokens: 110 };
  assert.deepEqual(
    normalizeProviderUsage({
      ...usage,
      completion_tokens_details: { reasoning_tokens: 80, provider_metadata: "private", text_tokens: 100 },
    }),
    { ...usage, completion_tokens_details: { reasoning_tokens: 80 } },
  );
  assert.deepEqual(
    normalizeProviderUsage({
      ...usage,
      completion_tokens_details: { reasoning_tokens: 0 },
    }),
    { ...usage, completion_tokens_details: { reasoning_tokens: 0 } },
  );
  for (const reasoningTokens of [-1, 101, 1.5, "80", null]) {
    assert.deepEqual(
      normalizeProviderUsage({
        ...usage,
        completion_tokens_details: { reasoning_tokens: reasoningTokens },
      }),
      usage,
    );
  }
});

test("Cloudflare request expands account ID and normalizes its REST response", async () => {
  const route = {
    route_id: "test-cloudflare",
    provider: "cloudflare-workers-ai",
    credential_pool: "cloudflare-workers-ai-production",
    upstream_model: "@cf/meta/llama-test",
    timeout_ms: 1000,
  };
  const pool = requireProviderPool(route.credential_pool);
  const credential = {
    credentialId: "cf-test",
    provider: route.provider,
    secrets: { api_token: "cf-secret", account_id: "account 1" },
  };
  let requestedUrl = "";
  const result = await invokeProviderRoute({
    route,
    pool,
    credential,
    body: { messages: [{ role: "user", content: "hello" }] },
    fetchImpl: async (url: any) => {
      requestedUrl = url;
      return jsonResponse(
        {
          success: true,
          result: {
            response: "hello back",
            usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
          },
        },
        { headers: { "cf-ray": "ray-test" } },
      );
    },
  });
  assert.match(requestedUrl, /accounts\/account%201\/ai\/run\/@cf\/meta\/llama-test$/);
  assert.equal(result.payload.choices[0].message.content, "hello back");
  assert.equal(result.inputTokens, 4);
  assert.equal(result.outputTokens, 2);
  assert.equal(result.upstreamRequestId, "ray-test");

  const chatCompletion = await invokeProviderRoute({
    route,
    pool,
    credential,
    body: { messages: [{ role: "user", content: "hello" }] },
    fetchImpl: async () =>
      jsonResponse({
        success: true,
        result: {
          id: "cf-chat-completion",
          choices: [
            { index: 0, message: { role: "assistant", content: "modern response" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        },
      }),
  });
  assert.equal(chatCompletion.payload.choices[0].message.content, "modern response");
  assert.equal(chatCompletion.inputTokens, 5);
  assert.equal(chatCompletion.outputTokens, 3);
});

test("Cloudflare native binding bypasses REST credentials and normalizes JSON output", async () => {
  const route = {
    route_id: "test-cloudflare-binding",
    provider: "cloudflare-workers-ai",
    credential_pool: "cloudflare-workers-ai-production",
    upstream_model: "@cf/meta/llama-test",
    timeout_ms: 1000,
  };
  let bindingCall: any;
  let fetchCalls = 0;
  const result = await invokeProviderRoute({
    route,
    pool: requireProviderPool(route.credential_pool),
    credential: { credentialId: "native", provider: route.provider, secrets: {} },
    body: {
      model: "beacon/public",
      messages: [{ role: "user", content: "hello" }],
      max_completion_tokens: 12,
    },
    cloudflareAiBinding: {
      async run(model: any, input: any, options: any) {
        bindingCall = [model, input, options];
        return {
          response: "native response",
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
        };
      },
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("REST must not be called when the native binding is available.");
    },
  });

  assert.equal(fetchCalls, 0);
  assert.equal(bindingCall[0], route.upstream_model);
  assert.deepEqual(bindingCall[1], {
    messages: [{ role: "user", content: "hello" }],
    max_tokens: 12,
    stream: false,
  });
  assert.equal(bindingCall[2].signal instanceof AbortSignal, true);
  assert.equal(result.payload.choices[0].message.content, "native response");
  assert.equal(result.inputTokens, 4);
  assert.equal(result.outputTokens, 2);
});

test("Cloudflare native binding normalizes OpenAI-compatible JSON output without REST", async () => {
  const route = {
    route_id: "test-cloudflare-binding-chat-completion",
    provider: "cloudflare-workers-ai",
    credential_pool: "cloudflare-workers-ai-production",
    upstream_model: "@cf/qwen/qwen3.8-27b",
    timeout_ms: 1000,
  };
  let bindingCall: any;
  let fetchCalls = 0;
  const result = await invokeProviderRoute({
    route,
    pool: requireProviderPool(route.credential_pool),
    credential: { credentialId: "native", provider: route.provider, secrets: {} },
    body: {
      model: "beacon/qwen-3.8-27b",
      messages: [{ role: "user", content: "hello" }],
      max_completion_tokens: 12,
    },
    cloudflareAiBinding: {
      async run(model: any, input: any) {
        bindingCall = [model, input];
        return {
          id: "native-chat-completion",
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "native modern response" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        };
      },
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("REST must not be called when the native binding is available.");
    },
  });

  assert.equal(fetchCalls, 0);
  assert.equal(bindingCall[0], route.upstream_model);
  assert.deepEqual(bindingCall[1], {
    messages: [{ role: "user", content: "hello" }],
    max_tokens: 12,
    stream: false,
  });
  assert.equal(result.payload.choices[0].message.content, "native modern response");
  assert.equal(result.inputTokens, 5);
  assert.equal(result.outputTokens, 3);
  assert.equal(result.usageSource, "provider");
  assert.equal(result.upstreamRequestId, "native-chat-completion");
});

test("Cloudflare native binding preserves its SSE stream and cancellation lifecycle", async () => {
  const route = {
    route_id: "test-cloudflare-binding-stream",
    provider: "cloudflare-workers-ai",
    credential_pool: "cloudflare-workers-ai-production",
    upstream_model: "@cf/meta/llama-test",
    timeout_ms: 1000,
  };
  const encoder = new TextEncoder();
  const nativeStream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode("data: {response:hello}\n\n"));
      controller.enqueue(
        encoder.encode("data: {usage:{prompt_tokens:4,completion_tokens:2,total_tokens:6}}\n\n"),
      );
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  const result = await invokeProviderRoute({
    route,
    pool: requireProviderPool(route.credential_pool),
    credential: { credentialId: "native", provider: route.provider, secrets: {} },
    body: { messages: [{ role: "user", content: "hello" }], stream: true },
    cloudflareAiBinding: { run: async () => nativeStream },
    fetchImpl: async () => {
      throw new Error("REST must not be called when the native binding is available.");
    },
  });

  const events: any[] = [];
  for await (const event of parseSseStream(result.response.body)) events.push(event.data);
  result.dispose();
  assert.equal(result.stream, true);
  assert.deepEqual(events, [
    "{response:hello}",
    "{usage:{prompt_tokens:4,completion_tokens:2,total_tokens:6}}",
    "[DONE]",
  ]);
});

test("OpenAI-compatible responses preserve completion payload and usage", async () => {
  const result = await invokeProviderRoute({
    route: openRouterRoute,
    pool: requireProviderPool(openRouterRoute.credential_pool),
    credential: openRouterCredential(),
    body: { messages: [{ role: "user", content: "hello" }] },
    fetchImpl: async () =>
      jsonResponse({
        id: "generation-1",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      }),
  });
  assert.equal(result.payload.id, "generation-1");
  assert.equal(result.inputTokens, 7);
  assert.equal(result.outputTokens, 3);
  assert.equal(result.usageSource, "provider");
});

test("non-stream usage is trusted only when token counts are complete, integral, and consistent", async () => {
  const cloudflareRoute = {
    route_id: "usage-cloudflare",
    provider: "cloudflare-workers-ai",
    credential_pool: "cloudflare-workers-ai-production",
    upstream_model: "@cf/meta/llama-test",
    timeout_ms: 1000,
  };
  const adapters = [
    {
      name: "OpenAI-compatible",
      invoke: (usage: any) =>
        invokeProviderRoute({
          route: openRouterRoute,
          pool: requireProviderPool(openRouterRoute.credential_pool),
          credential: openRouterCredential(),
          body: { messages: [{ role: "user", content: "hello" }] },
          fetchImpl: async () =>
            jsonResponse({
              choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
              usage,
            }),
        }),
    },
    {
      name: "Cloudflare",
      invoke: (usage: any) =>
        invokeProviderRoute({
          route: cloudflareRoute,
          pool: requireProviderPool(cloudflareRoute.credential_pool),
          credential: {
            credentialId: "cf-usage-test",
            provider: cloudflareRoute.provider,
            secrets: { api_token: "cf-secret", account_id: "account-1" },
          },
          body: { messages: [{ role: "user", content: "hello" }] },
          fetchImpl: async () =>
            jsonResponse({
              success: true,
              result: { response: "ok", usage },
            }),
        }),
    },
  ];
  const invalidUsages = [
    ["malformed", "not-an-object"],
    ["partial", { prompt_tokens: 7, total_tokens: 7 }],
    ["string token count", { prompt_tokens: "7", completion_tokens: 3, total_tokens: 10 }],
    ["fractional token count", { prompt_tokens: 7, completion_tokens: 2.5, total_tokens: 9.5 }],
    ["negative token count", { prompt_tokens: -1, completion_tokens: 3, total_tokens: 2 }],
    [
      "unsafe token count",
      {
        prompt_tokens: Number.MAX_SAFE_INTEGER + 1,
        completion_tokens: 0,
        total_tokens: Number.MAX_SAFE_INTEGER + 1,
      },
    ],
    ["string total", { prompt_tokens: 7, completion_tokens: 3, total_tokens: "10" }],
    ["inconsistent total", { prompt_tokens: 7, completion_tokens: 3, total_tokens: 11 }],
  ];

  for (const adapter of adapters) {
    for (const [description, usage] of invalidUsages) {
      const result = await adapter.invoke(usage);
      assert.equal(
        result.usageSource,
        "estimated",
        `${adapter.name} ${description} usage must not be trusted`,
      );
    }

    const totalOmitted = await adapter.invoke({ prompt_tokens: 7, completion_tokens: 3 });
    assert.equal(totalOmitted.usageSource, "provider", `${adapter.name} may omit total_tokens`);
    assert.equal(totalOmitted.inputTokens, 7);
    assert.equal(totalOmitted.outputTokens, 3);
  }
});

test("HTTP 200 embedded provider errors are usage-unknown and never fallback-safe", async () => {
  await assert.rejects(
    invokeProviderRoute({
      route: openRouterRoute,
      pool: requireProviderPool(openRouterRoute.credential_pool),
      credential: openRouterCredential(),
      body: { messages: [{ role: "user", content: "hello" }] },
      fetchImpl: async () =>
        jsonResponse({
          id: "generation-partial",
          choices: [
            {
              message: { role: "assistant", content: "partial" },
              finish_reason: "error",
              error: { code: 502, metadata: { error_type: "provider_unavailable" } },
            },
          ],
        }),
    }),
    (error: any) =>
      error instanceof BeaconProviderError &&
      error.responseStarted === true &&
      error.usageUnknown === true &&
      error.fallbackAllowed === false &&
      error.category === "embedded_provider_error",
  );
});

test("HTTP 2xx responses with non-array choices are normalized without leaking a TypeError", async () => {
  await assert.rejects(
    invokeProviderRoute({
      route: openRouterRoute,
      pool: requireProviderPool(openRouterRoute.credential_pool),
      credential: openRouterCredential(),
      body: { messages: [{ role: "user", content: "hello" }] },
      fetchImpl: async () => jsonResponse({ choices: { invalid: true } }),
    }),
    (error: any) => {
      assert.equal(error instanceof BeaconProviderError, true);
      assert.notEqual(error.name, "TypeError");
      assert.equal(error.category, "invalid_provider_response");
      assert.equal(error.responseStarted, true);
      assert.equal(error.usageUnknown, true);
      assert.equal(error.fallbackAllowed, false);
      return true;
    },
  );
});

test("provider HTTP failures are normalized without copying the upstream body", async () => {
  await assert.rejects(
    invokeProviderRoute({
      route: openRouterRoute,
      pool: requireProviderPool(openRouterRoute.credential_pool),
      credential: openRouterCredential(),
      body: { messages: [{ role: "user", content: "hello" }] },
      fetchImpl: async () =>
        jsonResponse(
          { error: { message: "contains-sensitive-upstream-data" } },
          {
            status: 429,
            headers: { "retry-after": "2" },
          },
        ),
    }),
    (error: any) => {
      assert.equal(error instanceof BeaconProviderError, true);
      assert.equal(error.category, "rate_limited");
      assert.equal(error.retryAfter, 2);
      assert.equal(error.fallbackAllowed, true);
      assert.doesNotMatch(error.message, /sensitive/);
      return true;
    },
  );
});

test("oversized provider JSON is cancelled and normalized as an invalid response", async () => {
  await assert.rejects(
    invokeProviderRoute({
      route: openRouterRoute,
      pool: requireProviderPool(openRouterRoute.credential_pool),
      credential: openRouterCredential(),
      body: { messages: [{ role: "user", content: "hello" }] },
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "x".repeat(4 * 1024 * 1024) } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    }),
    (error: any) =>
      error instanceof BeaconProviderError &&
      error.category === "invalid_provider_response" &&
      !/xxxx/.test(error.message),
  );
});

test("fallback advances after pre-stream provider failure and stops on invalid requests", async () => {
  const routes = [
    openRouterRoute,
    {
      ...openRouterRoute,
      route_id: "test-hugging-face",
      provider: "hugging-face",
      credential_pool: "hugging-face-production",
    },
  ];
  const env = {
    OPENROUTER_API_KEY_1: "openrouter-secret",
    HUGGING_FACE_API_KEY_1: "hf-secret",
  };
  const attempts: any[] = [];
  const success = await invokeWithProviderFallback({
    routes,
    body: { messages: [{ role: "user", content: "hello" }] },
    env,
    fetchImpl: async (url: any) =>
      url.includes("openrouter")
        ? jsonResponse({ error: true }, { status: 503 })
        : jsonResponse({ choices: [{ message: { role: "assistant", content: "fallback" } }] }),
    onAttempt: async ({ route, outcome }: any) => attempts.push([route.provider, outcome]),
  });
  assert.equal(success.provider, "hugging-face");
  assert.deepEqual(attempts, [
    ["openrouter", "failed"],
    ["hugging-face", "succeeded"],
  ]);

  let callCount = 0;
  await assert.rejects(
    invokeWithProviderFallback({
      routes,
      body: { messages: [] },
      env,
      fetchImpl: async () => {
        callCount += 1;
        return jsonResponse({ error: true }, { status: 400 });
      },
    }),
    (error: any) => error.category === "invalid_request",
  );
  assert.equal(callCount, 1);
});

test("secret resolver fails closed without exposing secret values", () => {
  const pool = requireProviderPool("openrouter-production");
  assert.throws(
    () => resolveProviderCredential(pool, pool.credentials[0], {}),
    (error: any) =>
      error.code === "PROVIDER_SECRET_NOT_CONFIGURED" && !error.message.includes("secret-test-key"),
  );
});

test("SSE parser handles comments, fragmented chunks, multiline data, and DONE", async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(": keepalive\r\nda"));
      controller.enqueue(encoder.encode('ta: {"choices":[]}\r\n\r\nevent: error\n'));
      controller.enqueue(encoder.encode("data: first\ndata: second\n\ndata: [DONE]\n\n"));
      controller.close();
    },
  });
  const events: any[] = [];
  for await (const event of parseSseStream(stream)) events.push(event);
  assert.deepEqual(events, [
    { event: "message", data: '{"choices":[]}' },
    { event: "error", data: "first\nsecond" },
    { event: "message", data: "[DONE]" },
  ]);
});

test("SSE parser preserves byte-split CRLF, UTF-8, and multiline data", async () => {
  const bytes = new TextEncoder().encode("event: reasoning\r\ndata: first中文😀\r\ndata: second\r\n\r\n");
  const stream = new ReadableStream({
    start(controller) {
      for (let index = 0; index < bytes.length; index += 1) {
        controller.enqueue(bytes.slice(index, index + 1));
      }
      controller.close();
    },
  });

  const events: any[] = [];
  for await (const event of parseSseStream(stream)) events.push(event);
  assert.deepEqual(events, [{ event: "reasoning", data: "first中文😀\nsecond" }]);
});

test("SSE parser discards a final event without a trailing blank line", async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: [DONE]"));
      controller.close();
    },
  });

  const events: any[] = [];
  for await (const event of parseSseStream(stream)) events.push(event);
  assert.deepEqual(events, []);
});

test("SSE parser cancels its reader when a consumer stops early", async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: first\n\ndata: second\n\n"));
    },
    cancel() {
      cancelled = true;
    },
  });

  for await (const event of parseSseStream(stream)) {
    assert.equal(event.data, "first");
    break;
  }
  assert.equal(cancelled, true);
});

test("SSE parser rejects and cancels an oversized event", async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${"x".repeat(1025)}\n\n`));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(async () => {
    for await (const _event of parseSseStream(stream, { maxEventCharacters: 1024 })) {
      // The oversized event must never be yielded.
    }
  }, /size limit/);
  assert.equal(cancelled, true);
});
