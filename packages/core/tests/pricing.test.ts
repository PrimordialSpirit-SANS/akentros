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

const GPT_6_ASTRA = "akentros/gpt-6-astra";
const GPT_52 = "akentros/gpt-5.2";
const GPT_52_CODEX = "akentros/gpt-5.2-codex";
const CLAUDE_OPUS_48 = "akentros/claude-opus-4-8";
const QWEN_38_27B = "akentros/qwen-3.8-27b";
const QWEN_38_FLASH = "akentros/qwen-3.8-flash";

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
      GPT_6_ASTRA,
      GPT_52,
      GPT_52_CODEX,
      CLAUDE_OPUS_48,
      "akentros/claude-sonnet-5",
      "akentros/claude-haiku-4-5",
      "akentros/gemini-3.5-pro",
      "akentros/gemini-3.8-flash",
      "akentros/gemini-3.5-flash-lite",
      "akentros/grok-4.6",
      "akentros/grok-4.1-fast",
      "akentros/deepseek-v4-pro",
      "akentros/deepseek-v4.1-flash",
      "akentros/kimi-k3",
      "akentros/glm-5.3",
      "akentros/glm-5.3-flash",
      "akentros/qwen-3.8-max",
      QWEN_38_FLASH,
      QWEN_38_27B,
    ],
  );
  assert.equal(getModelPricing(GPT_6_ASTRA), BACKEND_PRICING.models[GPT_6_ASTRA]);
  assert.equal(getModelPricing(GPT_52), BACKEND_PRICING.models[GPT_52]);
  assert.equal(getModelPricing(GPT_52_CODEX), BACKEND_PRICING.models[GPT_52_CODEX]);
  assert.equal(getModelPricing(CLAUDE_OPUS_48), BACKEND_PRICING.models[CLAUDE_OPUS_48]);
  assert.equal(getModelPricing(QWEN_38_27B), BACKEND_PRICING.models[QWEN_38_27B]);
  assert.equal(getModelPricing("akentros/unknown"), null);
  assert.throws(() => requireModelPricing("akentros/unknown"), {
    name: "RangeError",
    message: "Unknown or disabled Akentros model: akentros/unknown",
  });
});

test("USD billing is exact to micro-USD, rounds up once, and applies the minimum charge", () => {
  // 0 tokens 仍收最低消費 $0.0001 = 100 µUSD
  assert.equal(calculateActualCostMicros(QWEN_38_FLASH, 0, 0), 100);
  // 1M in ($0.15) + 0.5M out ($0.24) = $0.39 = 390000 µUSD,無須進位
  assert.equal(calculateActualCostMicros(QWEN_38_FLASH, 1_000_000, 500_000), 390000);

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
    ["akentros/qwen-3.8-max", "2.01", "6.00"],
    [QWEN_38_FLASH, "0.15", "0.48"],
    ["akentros/glm-5.3", "1.41", "4.41"],
    ["akentros/kimi-k3", "3.00", "15.00"],
    ["akentros/deepseek-v4.1-flash", "0.15", "0.60"],
    ["akentros/deepseek-v4-pro", "1.32", "3.96"],
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
  const model = requireModelPricing(QWEN_38_27B);
  assert.equal(
    calculateReservationCostMicros(QWEN_38_27B, 10_000),
    calculateReservationCostMicros(QWEN_38_27B, 10_000, model.limits.default_max_completion_tokens),
  );
  assert.throws(
    () => calculateReservationCostMicros(QWEN_38_27B, model.limits.max_input_tokens + 1, 1),
    /Estimated input tokens exceed the model input limit/,
  );
  assert.throws(
    () => calculateReservationCostMicros(QWEN_38_27B, 1, model.limits.max_completion_tokens + 1),
    /Requested output tokens exceed the model output limit/,
  );
});

test("billing snapshots are auditable and candidate routes are priority ordered", () => {
  const snapshot = createBillingSnapshot(QWEN_38_27B);
  assert.deepEqual(snapshot, {
    pricing_revision: BACKEND_PRICING.revision,
    model: QWEN_38_27B,
    currency: { ...BACKEND_PRICING.currency },
    billing: { ...BACKEND_PRICING.models[QWEN_38_27B].billing },
    limits: { ...BACKEND_PRICING.models[QWEN_38_27B].limits },
  });
  assert.deepEqual(
    listCandidateRoutes(QWEN_38_27B).map((route) => route.route_id),
    ["qwen-3.8-27b-cloudflare"],
  );
});

test("GPT-6 Astra bills its documented USD rate via the OpenAI route", () => {
  assert.equal(calculateActualCostMicros(GPT_6_ASTRA, 1_000_000, 1_000_000), 60010000);
  assert.deepEqual(
    listCandidateRoutes(GPT_6_ASTRA).map((route) => route.upstream_model),
    ["gpt-6-astra"],
  );
});

test("GPT-5.2 Codex exposes its dedicated OpenAI coding route", () => {
  assert.equal(calculateActualCostMicros(GPT_52_CODEX, 1_000_000, 1_000_000), 11280000);
  assert.deepEqual(
    listCandidateRoutes(GPT_52_CODEX).map((route) => route.upstream_model),
    ["gpt-5.2-codex"],
  );
});

test("Claude Opus 4.8 keeps its official Anthropic route", () => {
  assert.equal(calculateActualCostMicros(CLAUDE_OPUS_48, 1_000_000, 1_000_000), 30010000);
  assert.deepEqual(
    listCandidateRoutes(CLAUDE_OPUS_48).map((route) => route.upstream_model),
    ["claude-opus-4-8"],
  );
});

test("Gemini 3.5 Pro bills through the official Gemini API route", () => {
  assert.equal(calculateActualCostMicros("akentros/gemini-3.5-pro", 1_000_000, 1_000_000), 14030000);
  assert.deepEqual(
    listCandidateRoutes("akentros/gemini-3.5-pro").map((route) => route.upstream_model),
    ["gemini-3.5-pro"],
  );
});

test("Grok 4.6 bills through the official xAI route", () => {
  assert.equal(calculateActualCostMicros("akentros/grok-4.6", 1_000_000, 1_000_000), 8010000);
  assert.deepEqual(
    listCandidateRoutes("akentros/grok-4.6").map((route) => route.upstream_model),
    ["grok-4.6"],
  );
});

test("DeepSeek V4 Pro falls back from the official API to QwenCloud", () => {
  assert.equal(calculateActualCostMicros("akentros/deepseek-v4-pro", 1_000_000, 1_000_000), 5280000);
  assert.deepEqual(
    listCandidateRoutes("akentros/deepseek-v4-pro").map((route) => route.route_id),
    ["deepseek-v4-pro-deepseek", "deepseek-v4-pro-qwencloud"],
  );
});

test("Kimi K3 falls back from Moonshot AI to QwenCloud", () => {
  assert.equal(calculateActualCostMicros("akentros/kimi-k3", 1_000_000, 1_000_000), 18000000);
  assert.deepEqual(
    listCandidateRoutes("akentros/kimi-k3").map((route) => route.route_id),
    ["kimi-k3-moonshot", "kimi-k3-qwencloud"],
  );
});

test("GLM-5.3 falls back from Z.ai to QwenCloud", () => {
  assert.equal(calculateActualCostMicros("akentros/glm-5.3", 1_000_000, 1_000_000), 5820000);
  assert.deepEqual(
    listCandidateRoutes("akentros/glm-5.3").map((route) => route.route_id),
    ["glm-5.3-zhipu", "glm-5.3-qwencloud"],
  );
});

test("Qwen 3.8 27B exposes its separate paid Cloudflare route", () => {
  assert.equal(calculateActualCostMicros(QWEN_38_27B, 1_000_000, 1_000_000), 3420000);
  assert.deepEqual(
    listCandidateRoutes(QWEN_38_27B).map((route) => route.upstream_model),
    ["@cf/qwen/qwen3.8-27b"],
  );
});
