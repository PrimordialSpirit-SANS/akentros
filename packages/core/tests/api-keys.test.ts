import assert from "node:assert/strict";
import test from "node:test";
import { digestBeaconApiKey, generateBeaconApiKey } from "../../../apps/gateway/src/utils/aiApiKeys.ts";
import {
  isBeaconApiKey,
  isBeaconServiceRestricted,
  maskBeaconApiKey,
  normalizeBeaconKeyOptions,
  parseBeaconKeyId,
  serializeBeaconApiKey,
} from "../src/apiKeys.ts";

const TEST_PEPPER = "test-only-beacon-pepper-with-at-least-32-bytes";

test("Hono backend generates opaque Beacon keys", () => {
  for (const key of [generateBeaconApiKey("live"), generateBeaconApiKey("test")]) {
    assert.equal(isBeaconApiKey(key), true);
    assert.equal(key.includes("="), false);
  }
});

test("Hono backend derives deterministic HMAC digests", async () => {
  const secret = "sk-beacon-live_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop";
  const digest = await digestBeaconApiKey({}, secret, TEST_PEPPER);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(digest, await digestBeaconApiKey({}, secret, TEST_PEPPER));
  assert.notEqual(digest, await digestBeaconApiKey({}, secret, `${TEST_PEPPER}-other`));
});

test("key options are strict, bounded, and model-aware", () => {
  const expiresAt = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
  const clean = normalizeBeaconKeyOptions(
    {
      name: " Production ",
      environment: "live",
      model_allowlist: ["beacon/model-a", "beacon/model-a"],
      rpm_limit: 120,
      max_in_flight: 8,
      spend_limit_usd: "500.00",
      expires_at: expiresAt,
    },
    ["beacon/model-a"],
  );

  assert.deepEqual(clean, {
    name: "Production",
    environment: "live",
    modelAllowlist: ["beacon/model-a"],
    rpmLimit: 120,
    maxInFlight: 8,
    spendLimitUsdMicros: 500000000,
    expiresAt,
  });
  assert.throws(() => normalizeBeaconKeyOptions({ name: "" }), /1 to 80/);
  assert.throws(() => normalizeBeaconKeyOptions({ name: "bad", rpm_limit: 1.5 }), /rpm_limit/);
  assert.throws(
    () => normalizeBeaconKeyOptions({ name: "bad", model_allowlist: ["beacon/unknown"] }, ["beacon/model-a"]),
    /Unknown or disabled/,
  );
  assert.throws(() => normalizeBeaconKeyOptions({ name: "bad", extra: true }), /Unsupported/);
  assert.equal(
    normalizeBeaconKeyOptions({ name: "Zero budget", spend_limit_usd: "0.00" }).spendLimitUsdMicros,
    0,
  );
  assert.throws(
    () =>
      normalizeBeaconKeyOptions({
        name: "Too soon",
        expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
      }),
    /at least 1 hour/,
  );
});

test("key IDs preserve PostgreSQL BIGINT precision", () => {
  assert.equal(parseBeaconKeyId("1"), "1");
  assert.equal(parseBeaconKeyId("9223372036854775807"), "9223372036854775807");
  assert.equal(parseBeaconKeyId("9223372036854775808"), null);
  assert.equal(parseBeaconKeyId("01"), null);
  assert.equal(parseBeaconKeyId("1.5"), null);
});

test("developer metadata never serializes a full secret", () => {
  const secret = generateBeaconApiKey();
  const mask = maskBeaconApiKey(secret);
  const metadata: any = serializeBeaconApiKey({
    id: "9007199254740993",
    name: "CI",
    environment: "test",
    key_prefix: mask.key_prefix,
    key_suffix: mask.key_suffix,
    scopes: '["models:read"]',
    model_allowlist: "[]",
    rpm_limit: 60,
    max_in_flight: 4,
    spend_limit_usd_micros: null,
    spend_used_usd_micros: 25,
    is_active: true,
    expires_at: null,
    last_used_at: null,
    rotated_at: null,
    revoked_at: null,
    created_at: "2026-07-11T00:00:00Z",
  });

  assert.equal(metadata.id, "9007199254740993");
  assert.equal(metadata.key_prefix, mask.key_prefix);
  assert.equal(metadata.key_suffix, mask.key_suffix);
  assert.equal(metadata.spend_used_usd, "0.000025");
  assert.equal(JSON.stringify(metadata).includes(secret), false);
  assert.equal("secret" in metadata, false);
});

test("service restriction aliases cover parent and canonical Beacon links", () => {
  assert.equal(
    isBeaconServiceRestricted({
      is_flagged: true,
      restricted_services: '["/Developer"]',
    }),
    true,
  );
  assert.equal(
    isBeaconServiceRestricted({
      is_flagged: true,
      restricted_services: ["/Developer/ai-api"],
    }),
    true,
  );
  assert.equal(
    isBeaconServiceRestricted({
      is_flagged: false,
      restricted_services: ["/Developer/ai-api"],
    }),
    false,
  );
});
