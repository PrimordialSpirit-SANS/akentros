import assert from "node:assert/strict";
import test from "node:test";
import { authenticateBeaconApiKey, createBeaconApiKey, digestBeaconApiKey } from "../src/utils/aiApiKeys.ts";
import { ensureBeaconSchemaReady } from "../src/utils/bootstrap.ts";
import { dbGet, dbQuery, installNodeBeaconDbAdapter } from "../src/utils/db.ts";

// 回歸測試:expires_at 以 UTC ISO-8601 字串(含 T 與毫秒)儲存,過期比較
// 必須綁定同格式 now。曾有的 bug:與 SQLite CURRENT_TIMESTAMP(空格分隔)
// 做字典序比較,第 11 字元「T」>「空格」使「當天到期」的金鑰整日視為有效。

await installNodeBeaconDbAdapter();

const env = {
  BEACON_DB_PATH: ":memory:",
  BEACON_API_KEY_PEPPER: "pepper-".repeat(8),
};

async function insertTestUser(email: string) {
  const inserted = await dbQuery(
    env,
    `
    INSERT INTO users (username, email, password_hash, balance_usd_micros)
    VALUES ('expiry-tester', ?, 'x', 100000000)
    RETURNING id
  `,
    [email],
  );
  return String(inserted.rows[0].id);
}

async function insertKeyWithExpiry(userId: string, secretBody: string, expiresAt: string | null) {
  const secret = `sk-beacon-live_${secretBody}`;
  const digest = await digestBeaconApiKey(env, secret);
  await dbQuery(
    env,
    `
    INSERT INTO ai_api_keys (user_id, name, environment, key_prefix, key_suffix, key_digest, expires_at)
    VALUES (?, 'expiry regression', 'live', 'sk-beacon-live_', ?, ?, ?)
  `,
    [userId, secretBody.slice(-4), digest, expiresAt],
  );
  return secret;
}

test("authentication rejects a key that expired earlier on the current UTC day", async () => {
  await ensureBeaconSchemaReady(env);
  const userId = await insertTestUser("expiry-same-day@test.local");

  // 今日 UTC 午夜:任何時刻都已在過去,且保證與 now 同一 UTC 日,
  // 確定性踩中「ISO 字串 vs CURRENT_TIMESTAMP」的格式錯誤路徑。
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  const expiredSecret = await insertKeyWithExpiry(userId, "a".repeat(44), midnight.toISOString());
  assert.equal(await authenticateBeaconApiKey(env, expiredSecret), null);
});

test("authentication rejects a key expired on a previous UTC day", async () => {
  await ensureBeaconSchemaReady(env);
  const userId = await insertTestUser("expiry-past-day@test.local");
  const expiredSecret = await insertKeyWithExpiry(
    userId,
    "c".repeat(44),
    new Date(Date.now() - 24 * 60 * 60_000).toISOString(),
  );
  assert.equal(await authenticateBeaconApiKey(env, expiredSecret), null);
});

test("authentication accepts an unexpired key and returns no phantom user fields", async () => {
  await ensureBeaconSchemaReady(env);
  const userId = await insertTestUser("expiry-active@test.local");
  const activeSecret = await insertKeyWithExpiry(
    userId,
    "b".repeat(44),
    new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
  );
  const key = await authenticateBeaconApiKey(env, activeSecret);
  assert.ok(key, "unexpired key must authenticate");
  assert.equal(String(key.user_id), userId);
  // 曾有的 bug:user 物件讀取 SELECT 未包含的 points 欄位,永遠是 NaN。
  assert.ok(!("points" in key.user));
  assert.equal(String(key.user.id), userId);
});

test("created keys store ISO-8601 expiry that round-trips through authentication", async () => {
  await ensureBeaconSchemaReady(env);
  const userId = await insertTestUser("expiry-create@test.local");

  const created = await createBeaconApiKey(env, userId, {
    name: "ttl round-trip",
    expires_at: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
  });
  const row = await dbGet(env, "SELECT expires_at FROM ai_api_keys WHERE id = ?", [created.id]);
  assert.match(String(row?.expires_at), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(await authenticateBeaconApiKey(env, created.secret), "created key must authenticate");

  await assert.rejects(
    () =>
      createBeaconApiKey(env, userId, {
        name: "short ttl",
        expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
      }),
    /at least 1 hour/,
  );
});
