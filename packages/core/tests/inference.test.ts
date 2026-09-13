import assert from "node:assert/strict";
import test from "node:test";
import {
  createBeaconInferenceRuntime,
  listPublicBeaconModels,
  measureStreamChunkOutputChars,
  normalizeStreamChunk,
  prepareBeaconChatRequest,
  publicProviderError,
} from "../src/inference.ts";
import { BACKEND_PRICING } from "../src/pricing.ts";
import { BeaconProviderError, requireProviderPool } from "../src/providers.ts";

function aiKey(overrides: any = {}) {
  return {
    id: "17",
    model_allowlist: [],
    spend_limit_usd: null,
    user: { id: "23" },
    ...overrides,
  };
}

function body(overrides: any = {}) {
  return {
    model: "beacon/gemma-4-26b-a4b-it",
    messages: [{ role: "user", content: "Hello Beacon" }],
    ...overrides,
  };
}

function jsonProviderResponse(content = "Hello back") {
  return new Response(
    JSON.stringify({
      id: "upstream-secret-id",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function openRouterClaim() {
  return {
    leaseId: "lease-test",
    credentialId: "openrouter-primary",
    provider: "openrouter",
    secrets: { api_key: "provider-secret" },
    pool: requireProviderPool("openrouter-production"),
  };
}

function cloudflareClaim() {
  return {
    leaseId: "lease-cloudflare-test",
    credentialId: "cloudflare-native",
    provider: "cloudflare-workers-ai",
    secrets: {},
    pool: requireProviderPool("cloudflare-workers-ai-production"),
  };
}

function fakeBilling(overrides: any = {}) {
  const calls: any[] = [];
  const billing = {
    calls,
    reserve: async (reservation: any) => {
      calls.push(["reserve", reservation.requestId]);
      return { requestId: reservation.requestId, status: "reserved", idempotentReplay: false };
    },
    markDispatched: async (requestId: any) => calls.push(["dispatch", requestId]),
    settle: async (input: any) => {
      calls.push(["settle", input]);
      return { requestId: input.requestId, status: "succeeded" };
    },
    refund: async (input: any) => calls.push(["refund", input]),
    markNeedsReconciliation: async (input: any) => calls.push(["reconcile", input]),
    ...overrides,
  };
  return billing;
}

test("public model list exposes only stable Beacon model metadata", () => {
  const list = listPublicBeaconModels();
  assert.equal(list.object, "list");
  assert.equal(list.data.length, 35);
  for (const model of list.data) {
    assert.match(model.id, /^beacon\//);
    assert.equal(model.object, "model");
    assert.equal(model.owned_by, "beacon");
    assert.equal(typeof model.created, "number");
    assert.deepEqual(Object.keys(model).sort(), ["created", "id", "object", "owned_by"]);
  }
});

test("chat preparation validates allowlists, features, limits, and nested fingerprints", async () => {
  await assert.rejects(
    prepareBeaconChatRequest({
      body: body(),
      aiKey: aiKey({ model_allowlist: ["beacon/gpt-5"] }),
    }),
    (error: any) => error.status === 403 && error.code === "model_not_allowed",
  );
  const toolRequest = await prepareBeaconChatRequest({
    body: body({
      tools: [
        {
          type: "function",
          function: {
            name: "read_file",
            description: "Read a workspace file",
            parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          },
        },
      ],
      tool_choice: "auto",
    }),
    aiKey: aiKey(),
  });
  const plainRequest = await prepareBeaconChatRequest({ body: body(), aiKey: aiKey() });
  assert.ok(toolRequest.estimatedInputTokens > plainRequest.estimatedInputTokens);
  await assert.rejects(
    prepareBeaconChatRequest({
      body: body({
        model: "beacon/llama-3.2-1b-instruct",
        tools: [
          {
            type: "function",
            function: {
              name: "read_file",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      }),
      aiKey: aiKey(),
    }),
    (error: any) => error.status === 400 && error.code === "unsupported_feature",
  );
  assert.equal(toolRequest.body.tools![0].function.name, "read_file");
  await assert.rejects(
    prepareBeaconChatRequest({
      body: body({
        model: "beacon/llama-3.2-1b-instruct",
        messages: [
          {
            role: "assistant",
            tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }],
          },
        ],
      }),
      aiKey: aiKey(),
    }),
    (error: any) => error.status === 400 && error.code === "unsupported_feature",
  );

  assert.equal(toolRequest.body.tool_choice, "auto");
  await assert.rejects(
    prepareBeaconChatRequest({ body: body({ tools: [] }), aiKey: aiKey() }),
    (error: any) => error.status === 400 && error.param === "tools",
  );
  await assert.rejects(
    prepareBeaconChatRequest({ body: body({ max_completion_tokens: 999999 }), aiKey: aiKey() }),
    (error: any) => error.status === 400 && error.param === "max_completion_tokens",
  );
  await assert.rejects(
    prepareBeaconChatRequest({ body: body({ provider: "openrouter" }), aiKey: aiKey() }),
    (error: any) => error.status === 400 && error.code === "unsupported_parameter",
  );
  await assert.rejects(
    prepareBeaconChatRequest({
      body: body({
        model: "beacon/llama-3.2-1b-instruct",
        messages: [{ role: "user", content: "x".repeat(56_000) }],
      }),
      aiKey: aiKey(),
    }),
    (error: any) => error.status === 400 && error.code === "context_length_exceeded",
  );

  const first = await prepareBeaconChatRequest({
    body: body({ messages: [{ role: "user", content: "first" }] }),
    aiKey: aiKey(),
    idempotencyKey: "same-key",
  });
  const second = await prepareBeaconChatRequest({
    body: body({ messages: [{ role: "user", content: "second" }] }),
    aiKey: aiKey(),
    idempotencyKey: "same-key",
  });
  assert.notEqual(first.reservation.requestFingerprint, second.reservation.requestFingerprint);
  assert.equal(first.reservation.apiKeyId, "17");
  assert.equal(first.reservation.userId, "23");
  assert.equal(first.reservation.pricingRevision, BACKEND_PRICING.revision);

  await assert.rejects(
    prepareBeaconChatRequest({
      body: body({ stream: true, stream_options: { include_usage: false } }),
      aiKey: aiKey(),
    }),
    (error: any) => error.status === 400 && error.code === "unsupported_parameter",
  );

  const canonical = await prepareBeaconChatRequest({
    body: body({
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "canonical", vendor_hint: "must-not-pass" }],
    }),
    aiKey: aiKey(),
  });
  assert.deepEqual(canonical.body.messages, [{ role: "user", content: "canonical" }]);
  assert.deepEqual(canonical.body.stream_options, { include_usage: true });
  assert.doesNotMatch(JSON.stringify(canonical.body), /vendor_hint|openrouter/i);

  await assert.rejects(
    prepareBeaconChatRequest({
      body: body({ chat_template_kwargs: { thinking: true } }),
      aiKey: aiKey(),
    }),
    (error: any) => error.status === 400 && error.code === "unsupported_parameter",
  );
});

test("non-stream inference reserves, dispatches, calls provider, and settles in order", async () => {
  const prepared = await prepareBeaconChatRequest({ body: body(), aiKey: aiKey() });
  prepared.routes = [
    {
      route_id: "test-openrouter",
      provider: "openrouter",
      credential_pool: "openrouter-production",
      upstream_model: "owner/test-model",
      timeout_ms: 1000,
    },
  ];
  const billing = fakeBilling();
  const calls: any[] = [];
  const runtime = createBeaconInferenceRuntime({
    billing,
    claimCredential: async () => {
      calls.push("claim");
      return openRouterClaim();
    },
    releaseCredential: async (_claim: any, outcome: any) => calls.push(["release", outcome.success]),
    fetchImpl: async () => {
      calls.push("provider");
      return jsonProviderResponse();
    },
  });
  const result = await runtime.executeJson(prepared);
  assert.equal(result.body.model, prepared.modelId);
  assert.match(result.body.id, /^chatcmpl_/);
  assert.notEqual(result.body.id, "upstream-secret-id");
  assert.deepEqual(calls, ["claim", "provider", ["release", true]]);
  assert.deepEqual(
    billing.calls.map(([name]: any) => name),
    ["reserve", "dispatch", "settle"],
  );
});

for (const stream of [false, true]) {
  test(`${stream ? "streaming" : "JSON"} reasoning usage is billed once as part of completion tokens`, async () => {
    const prepared = await prepareBeaconChatRequest({
      body: body({ model: "beacon/qwen-3.8-max", max_completion_tokens: 8192, stream }),
      aiKey: aiKey(),
    });
    const usage = {
      prompt_tokens: 1000,
      completion_tokens: 8000,
      total_tokens: 9000,
      completion_tokens_details: { reasoning_tokens: 6000 },
    };
    const billing = fakeBilling();
    const runtime = createBeaconInferenceRuntime({
      billing,
      claimCredential: async () => ({
        leaseId: "reasoning-lease",
        credentialId: "qwencloud-primary",
        provider: "qwencloud",
        secrets: { api_key: "test-secret" },
        pool: requireProviderPool("qwencloud-production"),
      }),
      releaseCredential: async () => {},
      fetchImpl: async () =>
        stream
          ? new Response(`data: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n`, {
              headers: { "content-type": "text/event-stream" },
            })
          : new Response(
              JSON.stringify({
                choices: [
                  {
                    message: { role: "assistant", content: "answer", reasoning_content: "thinking" },
                    finish_reason: "stop",
                  },
                ],
                usage,
              }),
              { headers: { "content-type": "application/json" } },
            ),
    });
    if (stream) {
      const context = await runtime.openStream(prepared);
      let receivedUsage: any;
      for await (const event of context.events) {
        if (event.data === "[DONE]") break;
        receivedUsage = normalizeStreamChunk(JSON.parse(event.data), prepared).usage;
      }
      assert.deepEqual(receivedUsage, usage);
      await runtime.finalizeStream(context, receivedUsage);
    } else {
      const result = await runtime.executeJson(prepared);
      assert.deepEqual(result.body.usage, usage);
    }
    const settlements = billing.calls.filter(([name]: any) => name === "settle");
    assert.equal(settlements.length, 1);
    assert.equal(settlements[0][1].inputTokens, 1000);
    assert.equal(settlements[0][1].outputTokens, 8000);
    // $0.05001 含 reasoning;僅答案為 $0.0500,重複計算會到 $0.15003。
    assert.equal(settlements[0][1].actualCostMicros, 50010);
    assert.equal(settlements[0][1].usageSource, "provider");
  });
}

test("Worker runtime forwards the native Cloudflare AI binding instead of using REST", async () => {
  const prepared = await prepareBeaconChatRequest({
    body: body({ model: "beacon/llama-3.2-1b-instruct" }),
    aiKey: aiKey(),
  });
  const billing = fakeBilling();
  let bindingCalls = 0;
  const runtime = createBeaconInferenceRuntime({
    billing,
    claimCredential: async () => cloudflareClaim(),
    releaseCredential: async () => {},
    cloudflareAiBinding: {
      async run(model: any, input: any) {
        bindingCalls += 1;
        assert.equal(model, "@cf/meta/llama-3.2-1b-instruct");
        assert.equal(input.stream, false);
        return {
          response: "native runtime response",
          usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
        };
      },
    },
    fetchImpl: async () => {
      throw new Error("REST must not be called by the Worker native binding path.");
    },
  });

  const result = await runtime.executeJson(prepared);
  assert.equal(bindingCalls, 1);
  assert.equal(result.body.choices[0].message.content, "native runtime response");
  assert.equal(billing.calls.filter(([name]: any) => name === "settle").length, 1);
});

test("public non-stream completions strip execution metadata at every level", async () => {
  const prepared = await prepareBeaconChatRequest({ body: body(), aiKey: aiKey() });
  prepared.routes = [
    {
      route_id: "sanitize",
      provider: "openrouter",
      credential_pool: "openrouter-production",
      upstream_model: "owner/private",
      timeout_ms: 1000,
    },
  ];
  const runtime = createBeaconInferenceRuntime({
    billing: fakeBilling(),
    claimCredential: async () => openRouterClaim(),
    releaseCredential: async () => {},
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          id: "upstream-sentinel",
          model: "owner/private",
          provider: "openrouter-sentinel",
          system_fingerprint: "vendor-sentinel",
          service_tier: "vendor-tier",
          choices: [
            {
              index: 0,
              native_finish_reason: "eos",
              message: {
                role: "assistant",
                content: "safe answer",
                reasoning: "safe reasoning",
                refusal: null,
                vendor_trace: "vendor-sentinel",
              },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 3,
            completion_tokens: 2,
            total_tokens: 5,
            cost: 99,
            provider_details: "vendor-sentinel",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });
  const result = await runtime.executeJson(prepared);
  assert.deepEqual(Object.keys(result.body).sort(), ["choices", "created", "id", "model", "object", "usage"]);
  assert.deepEqual(result.body.choices, [
    {
      index: 0,
      message: {
        role: "assistant",
        content: "safe answer",
        reasoning: "safe reasoning",
        refusal: null,
      },
      finish_reason: "stop",
    },
  ]);
  assert.deepEqual(result.body.usage, {
    prompt_tokens: 3,
    completion_tokens: 2,
    total_tokens: 5,
  });
  assert.doesNotMatch(
    JSON.stringify(result.body),
    /upstream-sentinel|owner\/private|openrouter-sentinel|vendor-sentinel|vendor-tier|cost/i,
  );
});

test("reservation rejection and idempotent replay never call a provider", async () => {
  for (const reserve of [
    async () => {
      throw Object.assign(new Error("insufficient"), { status: 402, code: "insufficient_balance" });
    },
    async (reservation: any) => ({
      requestId: reservation.requestId,
      status: "succeeded",
      idempotentReplay: true,
    }),
  ]) {
    let providerCalls = 0;
    const prepared = await prepareBeaconChatRequest({ body: body(), aiKey: aiKey() });
    const runtime = createBeaconInferenceRuntime({
      billing: fakeBilling({ reserve }),
      claimCredential: async () => {
        providerCalls += 1;
        return openRouterClaim();
      },
      releaseCredential: async () => {},
      fetchImpl: async () => {
        providerCalls += 1;
        return jsonProviderResponse();
      },
    });
    await assert.rejects(runtime.executeJson(prepared));
    assert.equal(providerCalls, 0);
  }
});

test("pre-stream provider failure falls back and refunds only when all routes fail", async () => {
  const prepared = await prepareBeaconChatRequest({ body: body(), aiKey: aiKey() });
  prepared.routes = [
    {
      route_id: "first",
      provider: "openrouter",
      credential_pool: "openrouter-production",
      upstream_model: "one",
      timeout_ms: 1000,
    },
    {
      route_id: "second",
      provider: "openrouter",
      credential_pool: "openrouter-production",
      upstream_model: "two",
      timeout_ms: 1000,
    },
  ];
  let fetchCalls = 0;
  const billing = fakeBilling();
  const runtime = createBeaconInferenceRuntime({
    billing,
    claimCredential: async () => openRouterClaim(),
    releaseCredential: async () => {},
    fetchImpl: async () => {
      fetchCalls += 1;
      return fetchCalls === 1
        ? new Response("{}", { status: 503, headers: { "content-type": "application/json" } })
        : jsonProviderResponse("fallback");
    },
  });
  const result = await runtime.executeJson(prepared);
  assert.equal(fetchCalls, 2);
  assert.equal(result.body.choices[0].message.content, "fallback");
  assert.equal(
    billing.calls.some(([name]: any) => name === "refund"),
    false,
  );

  const failedBilling = fakeBilling();
  const failedRuntime = createBeaconInferenceRuntime({
    billing: failedBilling,
    claimCredential: async () => openRouterClaim(),
    releaseCredential: async () => {},
    fetchImpl: async () => new Response("{}", { status: 503 }),
  });
  await assert.rejects(failedRuntime.executeJson(prepared), (error: any) => error.status === 503);
  assert.equal(failedBilling.calls.filter(([name]: any) => name === "refund").length, 1);
});

test("fetch rejection after dispatch is reconciled without credential retry or route fallback", async () => {
  const prepared = await prepareBeaconChatRequest({ body: body(), aiKey: aiKey() });
  prepared.routes = [
    {
      route_id: "ambiguous-first",
      provider: "openrouter",
      credential_pool: "openrouter-production",
      upstream_model: "one",
      timeout_ms: 1000,
    },
    {
      route_id: "must-not-run",
      provider: "openrouter",
      credential_pool: "openrouter-production",
      upstream_model: "two",
      timeout_ms: 1000,
    },
  ];
  const billing = fakeBilling();
  let claimCalls = 0;
  let fetchCalls = 0;
  const releases: any[] = [];
  const runtime = createBeaconInferenceRuntime({
    billing,
    claimCredential: async () => {
      claimCalls += 1;
      return openRouterClaim();
    },
    releaseCredential: async (_claim: any, outcome: any) => releases.push(outcome),
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new TypeError("fetch failed for private-upstream.example");
    },
  });

  await assert.rejects(runtime.executeJson(prepared), (error: any) => {
    assert.equal(error.status, 503);
    assert.equal(error.type, "server_error");
    assert.equal(error.code, "service_unavailable");
    assert.equal(error.retryAfter, 5);
    assert.doesNotMatch(error.message, /fetch|private-upstream|provider|credential/i);
    return true;
  });
  assert.equal(claimCalls, 1);
  assert.equal(fetchCalls, 1);
  assert.equal(releases.length, 1);
  assert.equal(releases[0].success, false);
  assert.equal(releases[0].category, "provider_unavailable");
  assert.equal(
    billing.calls.some(([name]: any) => name === "refund"),
    false,
  );
  const reconciliations = billing.calls.filter(([name]: any) => name === "reconcile");
  assert.equal(reconciliations.length, 1);
  assert.equal(reconciliations[0][1].errorCode, "provider_unavailable");
});

test("a rejected credential is excluded and the same route tries the next credential", async () => {
  const prepared = await prepareBeaconChatRequest({ body: body(), aiKey: aiKey() });
  prepared.routes = [
    {
      route_id: "single-route",
      provider: "openrouter",
      credential_pool: "openrouter-production",
      upstream_model: "owner/model",
      timeout_ms: 1000,
    },
  ];
  const claims: any[] = [];
  let fetchCalls = 0;
  const runtime = createBeaconInferenceRuntime({
    billing: fakeBilling(),
    claimCredential: async (_route: any, _requestId: any, excludedCredentialIds: any) => {
      claims.push([...excludedCredentialIds]);
      if (!excludedCredentialIds.includes("credential-one")) {
        return { ...openRouterClaim(), credentialId: "credential-one" };
      }
      if (!excludedCredentialIds.includes("credential-two")) {
        return { ...openRouterClaim(), credentialId: "credential-two" };
      }
      return null;
    },
    releaseCredential: async () => {},
    fetchImpl: async () => {
      fetchCalls += 1;
      return fetchCalls === 1
        ? new Response("{}", { status: 403 })
        : jsonProviderResponse("second credential succeeded");
    },
  });
  const result = await runtime.executeJson(prepared);
  assert.equal(result.body.choices[0].message.content, "second credential succeeded");
  assert.equal(fetchCalls, 2);
  assert.deepEqual(claims, [[], ["credential-one"]]);
});

test("attempt audit start failures release the credential and fail closed before provider dispatch", async () => {
  const prepared = await prepareBeaconChatRequest({ body: body(), aiKey: aiKey() });
  prepared.routes = [
    {
      route_id: "audit-failure",
      provider: "openrouter",
      credential_pool: "openrouter-production",
      upstream_model: "owner/model",
      timeout_ms: 1000,
    },
  ];
  const billing = fakeBilling();
  const releases: any[] = [];
  let providerCalls = 0;
  const runtime = createBeaconInferenceRuntime({
    billing,
    attempts: {
      start: async () => {
        throw new Error("sensitive audit database failure");
      },
    },
    claimCredential: async () => openRouterClaim(),
    releaseCredential: async (_claim: any, outcome: any) => releases.push(outcome),
    fetchImpl: async () => {
      providerCalls += 1;
      return jsonProviderResponse();
    },
  });

  await assert.rejects(runtime.executeJson(prepared), (error: any) => {
    assert.equal(error.status, 503);
    assert.equal(error.type, "server_error");
    assert.equal(error.code, "service_unavailable");
    assert.equal(error.retryAfter, 5);
    assert.equal(
      error.message,
      "Beacon is temporarily unable to process this request. Please retry shortly.",
    );
    assert.doesNotMatch(error.message, /audit|database|provider|credential/i);
    return true;
  });
  assert.equal(providerCalls, 0);
  assert.equal(releases.length, 1);
  assert.equal(releases[0].success, false);
  assert.equal(releases[0].category, "attempt_audit_unavailable");
  assert.equal(billing.calls.filter(([name]: any) => name === "refund").length, 1);
});

test("stream chunks use public IDs and provider usage settles the reservation", async () => {
  const prepared = await prepareBeaconChatRequest({ body: body({ stream: true }), aiKey: aiKey() });
  prepared.routes = [
    {
      route_id: "stream-openrouter",
      provider: "openrouter",
      credential_pool: "openrouter-production",
      upstream_model: "owner/stream",
      timeout_ms: 1000,
    },
  ];
  const encoder = new TextEncoder();
  const upstream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode('data: {"id":"upstream","choices":[{"delta":{"content":"hi"}}]}\n\n'),
      );
      controller.enqueue(
        encoder.encode(
          'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n',
        ),
      );
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  const billing = fakeBilling();
  const releases: any[] = [];
  const runtime = createBeaconInferenceRuntime({
    billing,
    claimCredential: async () => openRouterClaim(),
    releaseCredential: async (_claim: any, outcome: any) => releases.push(outcome.success),
    fetchImpl: async () =>
      new Response(upstream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
  });
  const context = await runtime.openStream(prepared);
  let usage: any;
  for await (const event of context.events) {
    if (event.data === "[DONE]") break;
    const chunk = normalizeStreamChunk(JSON.parse(event.data), prepared);
    assert.match(chunk.id, /^chatcmpl_/);
    assert.equal(chunk.model, prepared.modelId);
    if (chunk.usage) usage = chunk.usage;
  }
  await runtime.finalizeStream(context, usage);
  assert.deepEqual(releases, [true]);
  assert.equal(billing.calls.filter(([name]: any) => name === "settle").length, 1);
});

test("Cloudflare native JSON SSE streams normalize and settle without REST", async () => {
  const prepared = await prepareBeaconChatRequest({
    body: body({ model: "beacon/llama-3.2-1b-instruct", stream: true }),
    aiKey: aiKey(),
  });
  const encoder = new TextEncoder();
  const billing = fakeBilling();
  const releases: any[] = [];
  let bindingCalls = 0;
  let fetchCalls = 0;
  const runtime = createBeaconInferenceRuntime({
    billing,
    claimCredential: async () => cloudflareClaim(),
    releaseCredential: async (_claim: any, outcome: any) => releases.push(outcome),
    cloudflareAiBinding: {
      async run(model: any, input: any) {
        bindingCalls += 1;
        assert.equal(model, "@cf/meta/llama-3.2-1b-instruct");
        assert.equal(input.stream, true);
        return new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ response: "hel" })}\n\n`));
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ response: "lo" })}\n\n`));
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ tool_calls: [], p: "opaque" })}\n\n`),
            );
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  response: "",
                  usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
                })}\n\n`,
              ),
            );
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        });
      },
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("REST must not be called by the native Cloudflare stream path.");
    },
  });

  const context = await runtime.openStream(prepared);
  const chunks: any[] = [];
  let usage: any;
  let sawDone = false;
  for await (const event of context.events) {
    if (event.data === "[DONE]") {
      sawDone = true;
      break;
    }
    const chunk = normalizeStreamChunk(JSON.parse(event.data), prepared);
    chunks.push(chunk);
    if (chunk.usage) usage = chunk.usage;
  }
  await runtime.finalizeStream(context, usage);

  assert.equal(bindingCalls, 1);
  assert.equal(fetchCalls, 0);
  assert.equal(sawDone, true);
  assert.equal(
    chunks
      .flatMap((chunk) => chunk.choices)
      .map((choice) => choice.delta.content || "")
      .join(""),
    "hello",
  );
  assert.equal(chunks[2].choices.length, 0);
  assert.equal("p" in chunks[2], false);
  assert.deepEqual(usage, { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
  assert.deepEqual(
    releases.map(({ success }: any) => success),
    [true],
  );
  const settlements = billing.calls.filter(([name]: any) => name === "settle");
  assert.equal(settlements.length, 1);
  // 5 in / 2 out 的實際金額不足 $0.0001,收最低消費 $0.0001 = 100 µUSD。
  assert.equal(settlements[0][1].actualCostMicros, 100);
  assert.equal(settlements[0][1].inputTokens, 5);
  assert.equal(settlements[0][1].outputTokens, 2);
});

test("malformed stream usage is ignored and the stream settles with a conservative estimate", async () => {
  const prepared = await prepareBeaconChatRequest({ body: body({ stream: true }), aiKey: aiKey() });
  prepared.routes = [
    {
      route_id: "stream-invalid-usage",
      provider: "openrouter",
      credential_pool: "openrouter-production",
      upstream_model: "owner/stream",
      timeout_ms: 1000,
    },
  ];
  const invalidUsages = [
    "not-an-object",
    { prompt_tokens: 5, total_tokens: 5 },
    { prompt_tokens: "5", completion_tokens: 2, total_tokens: 7 },
    { prompt_tokens: 5, completion_tokens: 1.5, total_tokens: 6.5 },
    { prompt_tokens: 5, completion_tokens: 2, total_tokens: 8 },
  ];
  const encoder = new TextEncoder();
  const upstream = new ReadableStream({
    start(controller) {
      for (const usage of invalidUsages) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [], usage })}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  const billing = fakeBilling();
  const runtime = createBeaconInferenceRuntime({
    billing,
    claimCredential: async () => openRouterClaim(),
    releaseCredential: async () => {},
    fetchImpl: async () =>
      new Response(upstream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
  });
  const context = await runtime.openStream(prepared);
  let trustedUsage: any;
  for await (const event of context.events) {
    if (event.data === "[DONE]") break;
    const chunk = normalizeStreamChunk(JSON.parse(event.data), prepared);
    assert.equal(chunk.usage, undefined);
    if (chunk.usage) trustedUsage = chunk.usage;
    context.estimatedOutputChars = (context.estimatedOutputChars || 0) + measureStreamChunkOutputChars(chunk);
  }
  await runtime.finalizeStream(context, trustedUsage);
  const settlements = billing.calls.filter(([name]: any) => name === "settle");
  assert.equal(settlements.length, 1);
  assert.equal(settlements[0][1].usageSource, "estimated");
  assert.equal(settlements[0][1].inputTokens, prepared.estimatedInputTokens);
  assert.ok(settlements[0][1].outputTokens > 0);
  assert.equal(
    billing.calls.some(([name]: any) => name === "reconcile"),
    false,
  );
});

test("Cloudflare native stream terminator is ignored and final response usage is preserved", async () => {
  const prepared = await prepareBeaconChatRequest({
    body: body({ model: "beacon/llama-4-scout-17b-16e-instruct", stream: true }),
    aiKey: aiKey(),
  });

  const control = normalizeStreamChunk({ tool_calls: [], p: "opaque" }, prepared);
  assert.deepEqual(control.choices, []);
  assert.equal(control.model, prepared.modelId);
  assert.equal("p" in control, false);

  const usage = { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 };
  const final = normalizeStreamChunk({ response: "", usage }, prepared);
  assert.deepEqual(final.choices, [
    {
      index: 0,
      delta: { content: "" },
      finish_reason: null,
    },
  ]);
  assert.deepEqual(final.usage, usage);

  assert.throws(
    () => normalizeStreamChunk({ tool_calls: [{ name: "unexpected" }] }, prepared),
    (error: any) => error instanceof BeaconProviderError && error.category === "invalid_provider_response",
  );
});

test("stream chunks preserve public content while stripping vendor metadata", async () => {
  const prepared = await prepareBeaconChatRequest({ body: body({ stream: true }), aiKey: aiKey() });
  const chunk = normalizeStreamChunk(
    {
      id: "upstream-sentinel",
      model: "owner/private",
      provider: "openrouter-sentinel",
      system_fingerprint: "vendor-sentinel",
      choices: [
        {
          index: 0,
          native_finish_reason: "eos",
          delta: {
            role: "assistant",
            content: "answer",
            reasoning_content: "thinking",
            vendor_trace: "vendor-sentinel",
          },
          finish_reason: "eos",
        },
      ],
      usage: {
        prompt_tokens: 4,
        completion_tokens: 2,
        total_tokens: 6,
        cost: 1,
      },
    },
    prepared,
  );
  assert.deepEqual(chunk.choices, [
    {
      index: 0,
      delta: { role: "assistant", content: "answer", reasoning_content: "thinking" },
      finish_reason: "stop",
    },
  ]);
  assert.deepEqual(chunk.usage, {
    prompt_tokens: 4,
    completion_tokens: 2,
    total_tokens: 6,
  });
  assert.doesNotMatch(
    JSON.stringify(chunk),
    /upstream-sentinel|owner\/private|openrouter-sentinel|vendor-sentinel|cost/i,
  );
});
test("stream chunks preserve OpenAI-compatible tool call deltas", async () => {
  const prepared = await prepareBeaconChatRequest({ body: body({ stream: true }), aiKey: aiKey() });
  const chunk = normalizeStreamChunk(
    {
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call_weather",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":"Taipei"}' },
                provider_trace: "drop-me",
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    },
    prepared,
  );

  assert.deepEqual(chunk.choices[0], {
    index: 0,
    delta: {
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id: "call_weather",
          type: "function",
          function: { name: "get_weather", arguments: '{"city":"Taipei"}' },
        },
      ],
    },
    finish_reason: "tool_calls",
  });
  assert.doesNotMatch(JSON.stringify(chunk), /provider_trace|drop-me/);
});

test("mid-stream errors never fall back or refund and are quarantined for reconciliation", async () => {
  const prepared = await prepareBeaconChatRequest({ body: body({ stream: true }), aiKey: aiKey() });
  prepared.routes = [
    {
      route_id: "first",
      provider: "openrouter",
      credential_pool: "openrouter-production",
      upstream_model: "one",
      timeout_ms: 1000,
    },
    {
      route_id: "second",
      provider: "openrouter",
      credential_pool: "openrouter-production",
      upstream_model: "two",
      timeout_ms: 1000,
    },
  ];
  const encoder = new TextEncoder();
  let providerCalls = 0;
  const billing = fakeBilling();
  const runtime = createBeaconInferenceRuntime({
    billing,
    claimCredential: async () => openRouterClaim(),
    releaseCredential: async () => {},
    fetchImpl: async () => {
      providerCalls += 1;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'data: {"error":{"code":502,"metadata":{"error_type":"provider_unavailable"}}}\n\n',
              ),
            );
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const context = await runtime.openStream(prepared);
  let streamError: any;
  for await (const event of context.events) {
    try {
      normalizeStreamChunk(JSON.parse(event.data), prepared);
    } catch (error: any) {
      streamError = error;
      break;
    }
  }
  assert.equal(streamError instanceof BeaconProviderError, true);
  assert.equal(streamError.responseStarted, true);
  await runtime.failStream(context, streamError);
  assert.equal(providerCalls, 1);
  assert.equal(
    billing.calls.some(([name]: any) => name === "refund"),
    false,
  );
  assert.equal(billing.calls.filter(([name]: any) => name === "reconcile").length, 1);
});

test("concurrent and repeated failStream calls finalize one stream context exactly once", async () => {
  const prepared = await prepareBeaconChatRequest({ body: body({ stream: true }), aiKey: aiKey() });
  prepared.routes = [
    {
      route_id: "stream-idempotent-failure",
      provider: "openrouter",
      credential_pool: "openrouter-production",
      upstream_model: "owner/stream",
      timeout_ms: 1000,
    },
  ];
  const billing = fakeBilling();
  const attemptFinishes: any[] = [];
  const releases: any[] = [];
  const runtime = createBeaconInferenceRuntime({
    billing,
    attempts: {
      start: async () => ({ id: "attempt-one" }),
      finish: async (attempt: any, outcome: any) => attemptFinishes.push([attempt, outcome]),
    },
    claimCredential: async () => openRouterClaim(),
    releaseCredential: async (claim: any, outcome: any) => releases.push([claim, outcome]),
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
  });
  const context = await runtime.openStream(prepared);
  const firstError = new BeaconProviderError("first internal stream failure", {
    provider: "openrouter",
    category: "midstream_provider_error",
    responseStarted: true,
    usageUnknown: true,
  });
  const secondError = new BeaconProviderError("second internal stream failure", {
    provider: "openrouter",
    category: "different_error",
    responseStarted: true,
    usageUnknown: true,
  });

  const [firstResult, concurrentResult] = await Promise.all([
    runtime.failStream(context, firstError),
    runtime.failStream(context, secondError),
  ]);
  const repeatedResult = await runtime.failStream(context, secondError);

  assert.equal(firstResult, concurrentResult);
  assert.equal(firstResult, repeatedResult);
  assert.equal(attemptFinishes.length, 1);
  assert.equal(attemptFinishes[0][1].success, false);
  assert.equal(attemptFinishes[0][1].errorCategory, "midstream_provider_error");
  assert.equal(releases.length, 1);
  assert.equal(releases[0][1].success, false);
  assert.equal(releases[0][1].category, "midstream_provider_error");
  const reconciliations = billing.calls.filter(([name]: any) => name === "reconcile");
  assert.equal(reconciliations.length, 1);
  assert.equal(reconciliations[0][1].errorCode, "midstream_provider_error");
});

test("successful stream without provider usage settles with a conservative estimate", async () => {
  const prepared = await prepareBeaconChatRequest({ body: body({ stream: true }), aiKey: aiKey() });
  prepared.routes = [
    {
      route_id: "stream-no-usage",
      provider: "openrouter",
      credential_pool: "openrouter-production",
      upstream_model: "owner/stream",
      timeout_ms: 1000,
    },
  ];
  const encoder = new TextEncoder();
  const billing = fakeBilling();
  const runtime = createBeaconInferenceRuntime({
    billing,
    claimCredential: async () => openRouterClaim(),
    releaseCredential: async () => {},
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'data: {"choices":[{"delta":{"content":"ok","reasoning_content":"thinking"}}]}\n\ndata: [DONE]\n\n',
              ),
            );
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
  });
  const context = await runtime.openStream(prepared);
  for await (const event of context.events) {
    if (event.data === "[DONE]") break;
    const chunk = normalizeStreamChunk(JSON.parse(event.data), prepared);
    context.estimatedOutputChars = (context.estimatedOutputChars || 0) + measureStreamChunkOutputChars(chunk);
  }
  await runtime.finalizeStream(context, null);
  // 不再隔離退款:改以「保留時輸入估計 + 實際輸出長度」結算並標記 estimated。
  const settlements = billing.calls.filter(([name]: any) => name === "settle");
  assert.equal(settlements.length, 1);
  assert.equal(settlements[0][1].usageSource, "estimated");
  assert.equal(settlements[0][1].inputTokens, prepared.estimatedInputTokens);
  assert.ok(settlements[0][1].outputTokens > 0);
  assert.ok(settlements[0][1].outputTokens <= prepared.maxCompletionTokens);
  assert.equal(settlements[0][1].outputTokens, Math.ceil((2 + 8) / 4) + 8);
  assert.equal(
    billing.calls.some(([name]: any) => name === "reconcile"),
    false,
  );
});

test("JSON completion without provider usage settles with a conservative estimate", async () => {
  const prepared = await prepareBeaconChatRequest({ body: body(), aiKey: aiKey() });
  prepared.routes = [
    {
      route_id: "json-no-usage",
      provider: "openrouter",
      credential_pool: "openrouter-production",
      upstream_model: "owner/json",
      timeout_ms: 1000,
    },
  ];
  const billing = fakeBilling();
  const runtime = createBeaconInferenceRuntime({
    billing,
    claimCredential: async () => openRouterClaim(),
    releaseCredential: async () => {},
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: "Hello back",
                reasoning_content: "thought ".repeat(100),
              },
              finish_reason: "stop",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });
  const result = await runtime.executeJson(prepared);
  assert.equal(result.body.choices[0].message.content, "Hello back");
  const settlements = billing.calls.filter(([name]: any) => name === "settle");
  assert.equal(settlements.length, 1);
  assert.equal(settlements[0][1].usageSource, "estimated");
  assert.equal(settlements[0][1].inputTokens, prepared.estimatedInputTokens);
  assert.ok(settlements[0][1].outputTokens > 0);
  assert.equal(settlements[0][1].outputTokens, Math.ceil((10 + 800) / 4) + 8);
  assert.deepEqual(result.body.usage, {
    prompt_tokens: settlements[0][1].inputTokens,
    completion_tokens: settlements[0][1].outputTokens,
    total_tokens: settlements[0][1].inputTokens + settlements[0][1].outputTokens,
  });
  assert.equal(
    billing.calls.some(([name]: any) => name === "reconcile"),
    false,
  );
});

test("HTTP 200 embedded errors do not fallback or refund after dispatch", async () => {
  const prepared = await prepareBeaconChatRequest({ body: body(), aiKey: aiKey() });
  prepared.routes = [
    {
      route_id: "first",
      provider: "openrouter",
      credential_pool: "openrouter-production",
      upstream_model: "one",
      timeout_ms: 1000,
    },
    {
      route_id: "second",
      provider: "openrouter",
      credential_pool: "openrouter-production",
      upstream_model: "two",
      timeout_ms: 1000,
    },
  ];
  let providerCalls = 0;
  const billing = fakeBilling();
  const runtime = createBeaconInferenceRuntime({
    billing,
    claimCredential: async () => openRouterClaim(),
    releaseCredential: async () => {},
    fetchImpl: async () => {
      providerCalls += 1;
      return new Response(
        JSON.stringify({
          choices: [{ finish_reason: "error", error: { code: 502 } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  await assert.rejects(
    runtime.executeJson(prepared),
    (error: any) =>
      error.status === 503 &&
      error.code === "service_unavailable" &&
      !/provider|upstream|credential/i.test(error.message),
  );
  assert.equal(providerCalls, 1);
  assert.equal(
    billing.calls.some(([name]: any) => name === "refund"),
    false,
  );
  assert.equal(billing.calls.filter(([name]: any) => name === "reconcile").length, 1);
});

test("provider timeout after dispatch does not fallback and keeps billing for reconciliation", async () => {
  const prepared = await prepareBeaconChatRequest({ body: body(), aiKey: aiKey() });
  prepared.routes = [
    {
      route_id: "slow",
      provider: "openrouter",
      credential_pool: "openrouter-production",
      upstream_model: "slow",
      timeout_ms: 5,
    },
    {
      route_id: "must-not-run",
      provider: "openrouter",
      credential_pool: "openrouter-production",
      upstream_model: "other",
      timeout_ms: 1000,
    },
  ];
  let providerCalls = 0;
  const billing = fakeBilling();
  const runtime = createBeaconInferenceRuntime({
    billing,
    claimCredential: async () => openRouterClaim(),
    releaseCredential: async () => {},
    fetchImpl: async (_url: any, init: any) => {
      providerCalls += 1;
      return new Promise((_resolve: any, reject: any) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      });
    },
  });
  await assert.rejects(
    runtime.executeJson(prepared),
    (error: any) => error.status === 503 && error.code === "service_unavailable",
  );
  assert.equal(providerCalls, 1);
  assert.equal(
    billing.calls.some(([name]: any) => name === "refund"),
    false,
  );
  assert.equal(billing.calls.filter(([name]: any) => name === "reconcile").length, 1);
});

test("client disconnect aborts routing without fallback or refund", async () => {
  const prepared = await prepareBeaconChatRequest({ body: body(), aiKey: aiKey() });
  prepared.routes = [
    {
      route_id: "aborted",
      provider: "openrouter",
      credential_pool: "openrouter-production",
      upstream_model: "one",
      timeout_ms: 1000,
    },
    {
      route_id: "must-not-run",
      provider: "openrouter",
      credential_pool: "openrouter-production",
      upstream_model: "two",
      timeout_ms: 1000,
    },
  ];
  const controller = new AbortController();
  controller.abort(new Error("client disconnected"));
  let providerCalls = 0;
  const billing = fakeBilling();
  const runtime = createBeaconInferenceRuntime({
    billing,
    claimCredential: async () => openRouterClaim(),
    releaseCredential: async () => {},
    fetchImpl: async (_url: any, init: any) => {
      providerCalls += 1;
      if (init.signal.aborted) throw init.signal.reason;
      return jsonProviderResponse();
    },
  });
  await assert.rejects(
    runtime.executeJson(prepared, { signal: controller.signal }),
    (error: any) => error.status === 408 && error.code === "request_cancelled",
  );
  assert.equal(providerCalls, 1);
  assert.equal(
    billing.calls.some(([name]: any) => name === "refund"),
    false,
  );
  assert.equal(billing.calls.filter(([name]: any) => name === "reconcile").length, 1);
});

test("public provider errors never expose provider status, category, or identifiers", () => {
  const source = new BeaconProviderError("Cloudflare credential rejected upstream request abc", {
    provider: "cloudflare-workers-ai",
    status: 403,
    category: "credential_rejected",
    upstreamRequestId: "cf-ray-secret",
  });
  const safe = publicProviderError(source);
  assert.equal(safe.status, 503);
  assert.equal(safe.code, "service_unavailable");
  assert.equal(safe.retryAfter, 5);
  assert.doesNotMatch(
    JSON.stringify({ message: safe.message, code: safe.code }),
    /cloudflare|credential|upstream|cf-ray|403/i,
  );
});
