import assert from "node:assert/strict";
import test from "node:test";

import {
  BACKEND_PRICING,
  calculateActualCostMicros,
  calculateActualCostMicrosBigInt,
  calculateReservationCostMicros,
  createBillingSnapshot,
  getModelPricing,
  listCandidateRoutes,
  listEnabledModels,
  parseUsdToMicros,
  requireModelPricing,
} from "../src/pricing.ts";

const LLAMA_32_1B = "beacon/llama-3.2-1b-instruct";
const LLAMA_4_SCOUT = "beacon/llama-4-scout-17b-16e-instruct";
const GEMMA_4_26B = "beacon/gemma-4-26b-a4b-it";
const GPT_OSS_20B = "beacon/gpt-oss-20b";
const GPT_OSS_120B = "beacon/gpt-oss-120b";
const QWEN_38_27B = "beacon/qwen-3.8-27b";

function createSyntheticModel(billing: any) {
  return {
    billing,
    limits: {
      context_tokens: 10,
      max_input_tokens: 5,
      default_max_completion_tokens: 1,
      max_completion_tokens: 5,
    },
  };
}

test("canonical pricing exposes only enabled public models", () => {
  assert.deepEqual(
    listEnabledModels().map((model) => model.id),
    [
      LLAMA_32_1B,
      LLAMA_4_SCOUT,
      GEMMA_4_26B,
      GPT_OSS_20B,
      GPT_OSS_120B,
      QWEN_38_27B,
      "beacon/qwen-3.8-max",
      "beacon/qwen-3.8-flash",
      "beacon/glm-5.2",
      "beacon/kimi-k3",
      "beacon/deepseek-v4-flash",
      "beacon/deepseek-v4-pro",
      "beacon/gpt-5",
      "beacon/gpt-5-mini",
      "beacon/gpt-5-nano",
      "beacon/claude-sonnet-4-5",
      "beacon/claude-haiku-4-5",
      "beacon/claude-opus-4-1",
      "beacon/gemini-2.5-pro",
      "beacon/gemini-2.5-flash",
      "beacon/gemini-2.5-flash-lite",
      "beacon/grok-4",
      "beacon/grok-4-fast",
      "beacon/grok-code-fast",
      "beacon/llama-3.3-70b-instruct",
      "beacon/kimi-k2-instruct",
      "beacon/mistral-large",
      "beacon/codestral",
      "beacon/deepseek-v3.2",
      "beacon/deepseek-v3.2-reasoner",
      "beacon/sonar",
      "beacon/sonar-pro",
      "beacon/command-a",
      "beacon/command-r7b",
      "beacon/minimax-m2",
    ],
  );
  assert.equal(getModelPricing(LLAMA_32_1B), BACKEND_PRICING.models[LLAMA_32_1B]);
  assert.equal(getModelPricing(LLAMA_4_SCOUT), BACKEND_PRICING.models[LLAMA_4_SCOUT]);
  assert.equal(getModelPricing(GEMMA_4_26B), BACKEND_PRICING.models[GEMMA_4_26B]);
  assert.equal(getModelPricing(GPT_OSS_20B), BACKEND_PRICING.models[GPT_OSS_20B]);
  assert.equal(getModelPricing(GPT_OSS_120B), BACKEND_PRICING.models[GPT_OSS_120B]);
  assert.equal(getModelPricing(QWEN_38_27B), BACKEND_PRICING.models[QWEN_38_27B]);
  assert.equal(getModelPricing("beacon/unknown"), null);
  assert.throws(() => requireModelPricing("beacon/unknown"), {
    name: "RangeError",
    message: "Unknown or disabled Beacon model: beacon/unknown",
  });
});

test("USD billing is exact to micro-USD, rounds up once, and applies the minimum charge", () => {
  // 0 tokens 仍收最低消費 $0.0001 = 100 µUSD
  assert.equal(calculateActualCostMicros(LLAMA_32_1B, 0, 0), 100);
  // 1M in ($0.03) + 0.5M out ($0.105) = $0.135 = 135000 µUSD,無須進位
  assert.equal(calculateActualCostMicros(LLAMA_32_1B, 1_000_000, 500_000), 135000);

  const model = createSyntheticModel({
    input_usd_per_million_tokens: "0.40",
    output_usd_per_million_tokens: "0.40",
    minimum_charge_usd: "0",
  });
  // 1 token × $0.40/1M = 0.4 µUSD,單次向上取整到 1 µUSD
  assert.equal(calculateActualCostMicros(model, 1, 1), 1);
  assert.throws(
    () =>
      calculateActualCostMicros(
        createSyntheticModel({
          input_usd_per_million_tokens: "0.1234567",
          output_usd_per_million_tokens: "0.40",
          minimum_charge_usd: "0",
        }),
        1,
        1,
      ),
    { name: "TypeError" },
  );
});

test("USD rates pass through upstream provider prices exactly", () => {
  for (const [modelId, inputUsd, outputUsd] of [
    ["beacon/qwen-3.8-max", "2.01", "6.00"],
    ["beacon/qwen-3.8-flash", "0.15", "0.48"],
    ["beacon/glm-5.2", "1.41", "4.41"],
    ["beacon/kimi-k3", "3.00", "15.00"],
    ["beacon/deepseek-v4-flash", "0.21", "0.42"],
    ["beacon/deepseek-v4-pro", "1.32", "3.96"],
  ] as const) {
    assert.equal(calculateActualCostMicros(modelId, 1_000_000, 0), Number(parseUsdToMicros(inputUsd)));
    assert.equal(calculateActualCostMicros(modelId, 0, 1_000_000), Number(parseUsdToMicros(outputUsd)));
    assert.equal(calculateActualCostMicros(modelId, 1, 1), 100);
  }
});

test("BigInt billing remains exact beyond Number.MAX_SAFE_INTEGER", () => {
  const model = createSyntheticModel({
    input_usd_per_million_tokens: "3.00",
    output_usd_per_million_tokens: "7.00",
    minimum_charge_usd: "0",
  });

  // 1e18 tokens × $3.00/1M = $3e12 = 3e18 µUSD
  assert.equal(calculateActualCostMicrosBigInt(model, "1000000000000000000", "0"), 3000000000000000000n);
  assert.throws(() => calculateActualCostMicros(model, "10000000000000000000000", "0"), {
    name: "RangeError",
    message: "The calculated cost exceeds Number.MAX_SAFE_INTEGER micro-USD.",
  });
});

test("reservation billing uses the configured default and enforces model limits", () => {
  const model = requireModelPricing(LLAMA_32_1B);
  assert.equal(
    calculateReservationCostMicros(LLAMA_32_1B, 10_000),
    calculateReservationCostMicros(LLAMA_32_1B, 10_000, model.limits.default_max_completion_tokens),
  );
  assert.throws(
    () => calculateReservationCostMicros(LLAMA_32_1B, model.limits.max_input_tokens + 1, 1),
    /Estimated input tokens exceed the model input limit/,
  );
  assert.throws(
    () => calculateReservationCostMicros(LLAMA_32_1B, 1, model.limits.max_completion_tokens + 1),
    /Requested output tokens exceed the model output limit/,
  );
});

test("billing snapshots are auditable and candidate routes are priority ordered", () => {
  const snapshot = createBillingSnapshot(LLAMA_32_1B);
  assert.deepEqual(snapshot, {
    pricing_revision: BACKEND_PRICING.revision,
    model: LLAMA_32_1B,
    currency: { ...BACKEND_PRICING.currency },
    billing: { ...BACKEND_PRICING.models[LLAMA_32_1B].billing },
    limits: { ...BACKEND_PRICING.models[LLAMA_32_1B].limits },
  });
  assert.deepEqual(
    listCandidateRoutes(LLAMA_32_1B).map((route) => route.route_id),
    ["llama-3.2-1b-instruct-cloudflare"],
  );
});
test("Llama 3.2 1B bills its documented USD rate", () => {
  assert.equal(calculateActualCostMicros(LLAMA_32_1B, 1_000_000, 1_000_000), 240000);
  assert.deepEqual(
    listCandidateRoutes(LLAMA_32_1B).map((route) => route.upstream_model),
    ["@cf/meta/llama-3.2-1b-instruct"],
  );
});

test("Llama 4 Scout exposes its separate paid Cloudflare route", () => {
  assert.equal(calculateActualCostMicros(LLAMA_4_SCOUT, 1_000_000, 1_000_000), 1110000);
  assert.deepEqual(
    listCandidateRoutes(LLAMA_4_SCOUT).map((route) => route.upstream_model),
    ["@cf/meta/llama-4-scout-17b-16e-instruct"],
  );
});

test("Gemma 4 26B A4B exposes its separate paid Cloudflare route", () => {
  assert.equal(calculateActualCostMicros(GEMMA_4_26B, 1_000_000, 1_000_000), 420000);
  assert.deepEqual(
    listCandidateRoutes(GEMMA_4_26B).map((route) => route.upstream_model),
    ["@cf/google/gemma-4-26b-a4b-it"],
  );
});

test("GPT-OSS 20B exposes its separate paid Cloudflare route", () => {
  assert.equal(calculateActualCostMicros(GPT_OSS_20B, 1_000_000, 1_000_000), 510000);
  assert.deepEqual(
    listCandidateRoutes(GPT_OSS_20B).map((route) => route.upstream_model),
    ["@cf/openai/gpt-oss-20b"],
  );
});

test("GPT-OSS 120B keeps its Cloudflare route and adds Groq and Bedrock fallbacks", () => {
  assert.equal(calculateActualCostMicros(GPT_OSS_120B, 1_000_000, 1_000_000), 1110000);
  assert.deepEqual(
    listCandidateRoutes(GPT_OSS_120B).map((route) => route.upstream_model),
    ["@cf/openai/gpt-oss-120b", "openai/gpt-oss-120b", "openai.gpt-oss-120b-1:0"],
  );
});

test("Qwen 3.8 27B exposes its separate paid Cloudflare route", () => {
  assert.equal(calculateActualCostMicros(QWEN_38_27B, 1_000_000, 1_000_000), 3420000);
  assert.deepEqual(
    listCandidateRoutes(QWEN_38_27B).map((route) => route.upstream_model),
    ["@cf/qwen/qwen3.8-27b"],
  );
});
