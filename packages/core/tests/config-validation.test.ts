import assert from "node:assert/strict";
import test from "node:test";
import brands from "../../../apps/console/public/brand/beacon/providers/manifest.v1.json" with {
  type: "json",
};
import publicModels from "../../../apps/console/public/data/beacon/models.v1.json" with { type: "json" };
import publicOfferings from "../../../apps/console/public/data/beacon/provider-offerings.v1.json" with {
  type: "json",
};
import providerPools from "../config/provider-pools.v1.json" with { type: "json" };
import { BACKEND_PRICING } from "../src/pricing.ts";
import {
  assertValidConfigBundle,
  validateBackendPricing,
  validateConfigBundle,
  validateProviderPools,
} from "../src/validation.ts";

function clone(value: any) {
  return structuredClone(value);
}

test("canonical Beacon pricing and provider pool documents form a valid bundle", () => {
  assert.deepEqual(validateBackendPricing(BACKEND_PRICING), { valid: true, errors: [] });
  assert.deepEqual(validateProviderPools(providerPools), { valid: true, errors: [] });
  assert.deepEqual(validateConfigBundle(BACKEND_PRICING, providerPools), { valid: true, errors: [] });
  assert.deepEqual(assertValidConfigBundle(BACKEND_PRICING, providerPools), {
    pricing: BACKEND_PRICING,
    pools: providerPools,
  });
});

test("public catalogs match the active backend models, prices, limits and provider brands", () => {
  assert.equal(publicModels.pricing_revision, BACKEND_PRICING.revision);
  assert.equal(publicOfferings.pricing_revision, BACKEND_PRICING.revision);
  const enabledIds = Object.entries(BACKEND_PRICING.models)
    .filter(([, model]: [string, any]) => model.enabled)
    .map(([id]) => id);
  assert.deepEqual(
    publicModels.models.filter((model) => model.status === "available").map((model) => model.id),
    enabledIds,
  );
  for (const model of publicModels.models) {
    const backend = BACKEND_PRICING.models[model.id];
    assert.equal(model.context_window_tokens, backend.limits.context_tokens);
    assert.equal(model.max_output_tokens, backend.limits.max_completion_tokens);
    assert.ok(
      brands.assets.some((asset) => asset.id === model.owner_brand_asset_id && asset.kind === "model-owner"),
    );
    for (const field of [
      "input_usd_per_million_tokens",
      "output_usd_per_million_tokens",
      "minimum_charge_usd",
    ] as const) {
      assert.equal(String(model.billing[field]), backend.billing[field]);
    }
    for (const providerId of model.provider_ids) {
      const offering = publicOfferings.offerings.find(
        (entry) => entry.model_id === model.id && entry.provider_id === providerId,
      );
      assert.ok(offering, `Missing offering for ${model.id} / ${providerId}`);
      const provider = providerId === "cloudflare" ? "cloudflare-workers-ai" : providerId;
      assert.ok(
        backend.routes.some(
          (route: any) => route.enabled && route.provider === provider && route.route_id === offering.id,
        ),
      );
      assert.ok(
        brands.assets.some((asset) => asset.id === offering.brand_asset_id && asset.kind === "provider"),
      );
      assert.equal(offering.status, model.status);
      for (const field of [
        "input_usd_per_million_tokens",
        "output_usd_per_million_tokens",
        "minimum_charge_usd",
      ] as const) {
        assert.equal(offering[field], model.billing[field]);
      }
    }
  }
});

test("provider names use the canonical hugging-face vocabulary", () => {
  const pricing = clone(BACKEND_PRICING);
  pricing.models["beacon/qwen-3.8-27b"].routes[0].provider = "huggingface";

  const pools = clone(providerPools);
  pools.pools["hugging-face-production"].provider = "huggingface";

  assert.deepEqual(validateBackendPricing(pricing), {
    valid: false,
    errors: ["$.models.beacon/qwen-3.8-27b.routes[0].provider: is unsupported"],
  });
  assert.deepEqual(validateProviderPools(pools), {
    valid: false,
    errors: ["$.pools.hugging-face-production.provider: is unsupported"],
  });
});

test("each provider pool requires its provider-specific API style", () => {
  const cloudflare = clone(providerPools);
  cloudflare.pools["cloudflare-workers-ai-production"].api_style = "openai-compatible";
  assert.deepEqual(validateProviderPools(cloudflare), {
    valid: false,
    errors: [
      "$.pools.cloudflare-workers-ai-production.api_style: must equal cloudflare-rest for provider cloudflare-workers-ai",
    ],
  });

  const openrouter = clone(providerPools);
  openrouter.pools["openrouter-production"].api_style = "cloudflare-rest";
  assert.deepEqual(validateProviderPools(openrouter), {
    valid: false,
    errors: ["$.pools.openrouter-production.api_style: must equal openai-compatible for provider openrouter"],
  });

  const unsupported = clone(providerPools);
  unsupported.pools["hugging-face-production"].api_style = "custom";
  assert.deepEqual(validateProviderPools(unsupported), {
    valid: false,
    errors: ["$.pools.hugging-face-production.api_style: is unsupported"],
  });
});

test("bundle validation catches revision and route-to-pool drift", () => {
  const revisionDrift = clone(providerPools);
  revisionDrift.revision = "2026-07-11.2";
  assert.deepEqual(validateConfigBundle(BACKEND_PRICING, revisionDrift), {
    valid: false,
    errors: ["$.revision: pricing and provider pool revisions must match"],
  });

  const pricingDrift = clone(BACKEND_PRICING);
  pricingDrift.models["beacon/qwen-3.8-27b"].routes[0].credential_pool = "openrouter-production";
  assert.deepEqual(validateConfigBundle(pricingDrift, providerPools), {
    valid: false,
    errors: [
      "$.models.beacon/qwen-3.8-27b.routes.qwen-3.8-27b-cloudflare.provider: does not match its provider pool",
    ],
  });
});
