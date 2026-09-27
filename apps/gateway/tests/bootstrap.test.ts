import assert from "node:assert/strict";
import test from "node:test";
import { assertAkentrosSchemaReady } from "@akentros/core/schemaReadiness";
import { ensureAkentrosSchemaReady, seedAkentrosAdminFromEnv } from "../src/utils/bootstrap.ts";
import { createAkentrosQuery, dbGet, dbQuery, installNodeAkentrosDbAdapter } from "../src/utils/db.ts";
import { createUser, hashPassword } from "../src/utils/users.ts";

// Node adapter(node:sqlite)對共用的 bootstrap 流程做真實端到端驗證:
// Workers DO 首次啟動跑的是同一份 ensureAkentrosSchemaReady/seedAkentrosAdminFromEnv。

test("bootstrap migrates schema and seeds admin idempotently", async () => {
  await installNodeAkentrosDbAdapter();

  const env = {
    AKENTROS_DB_PATH: ":memory:",
    ADMIN_EMAIL: "admin@example.com",
    ADMIN_PASSWORD: "correct horse battery",
  };

  const first = await ensureAkentrosSchemaReady(env);
  assert.equal(first.migrated, true, "first run should apply pending migrations");
  await assertAkentrosSchemaReady((sql: any, params: any[] = []) => dbQuery(env, sql, params));

  const seededFirst = await seedAkentrosAdminFromEnv(env);
  assert.equal(seededFirst?.created, true);
  const admin = await dbGet(env, "SELECT email, role FROM users WHERE email = ?", ["admin@example.com"]);
  assert.equal(admin?.email, "admin@example.com");

  const second = await ensureAkentrosSchemaReady(env);
  assert.equal(second.migrated, false, "second run should find schema already ready");
  const seededSecond = await seedAkentrosAdminFromEnv(env);
  assert.equal(seededSecond?.created, false, "admin seed is idempotent");
});

test("bootstrap skips admin seed without ADMIN_EMAIL/ADMIN_PASSWORD", async () => {
  await installNodeAkentrosDbAdapter();
  const seeded = await seedAkentrosAdminFromEnv({ AKENTROS_DB_PATH: ":memory:" });
  assert.equal(seeded, null);
});

// 回歸測試(帳號預先註冊接管):公開註冊下,攻擊者搶先註冊 operator 之後
// 才設定的 ADMIN_EMAIL。種子對「密碼不符的既有帳號」必須拒絕升權並大聲
// 失敗,不得靜默把攻擊者帳號升成 admin(PoC 已驗證舊行為可被完全接管)。
test("admin seed refuses to promote a pre-registered account it does not own", async () => {
  await installNodeAkentrosDbAdapter();

  const env = {
    AKENTROS_DB_PATH: ":memory:",
    ADMIN_EMAIL: "admin@pre-hijack.test",
    ADMIN_PASSWORD: "operator-strong-password-XYZ",
    ADMIN_USERNAME: "admin",
  };
  await ensureAkentrosSchemaReady(env);

  // 攻擊者先以自己的密碼註冊該信箱
  const attackerHash = await hashPassword("attacker-pass-1", env);
  await createUser(env, {
    email: "admin@pre-hijack.test",
    username: "attacker",
    passwordHash: attackerHash,
    balanceUsdMicros: "5000000",
  });

  // operator 之後執行種子:必須拒絕
  await assert.rejects(seedAkentrosAdminFromEnv(env), (error: Error & { code?: string }) => {
    assert.equal(error.code, "AKENTROS_ADMIN_SEED_EMAIL_TAKEN");
    assert.match(error.message, /pre-hijacking/);
    return true;
  });

  // 帳號角色必須維持 user(未被升權)
  const row = await dbGet(env, "SELECT role FROM users WHERE email = ?", ["admin@pre-hijack.test"]);
  assert.equal(row?.role, "user", "pre-registered account must not be promoted to admin");
});

// 對照組:既有帳號就是 operator 自己的(密碼相符)→ 升權照常。
test("admin seed promotes an existing account when the seed password matches", async () => {
  await installNodeAkentrosDbAdapter();

  const env = {
    AKENTROS_DB_PATH: ":memory:",
    ADMIN_EMAIL: "admin@owned.test",
    ADMIN_PASSWORD: "my-own-password-123",
    ADMIN_USERNAME: "admin",
  };
  await ensureAkentrosSchemaReady(env);

  const ownHash = await hashPassword("my-own-password-123", env);
  await createUser(env, {
    email: "admin@owned.test",
    username: "operator",
    passwordHash: ownHash,
    balanceUsdMicros: "5000000",
  });

  const seeded = await seedAkentrosAdminFromEnv(env);
  assert.equal(seeded?.created, false, "existing account is not re-created");
  const row = await dbGet(env, "SELECT role FROM users WHERE email = ?", ["admin@owned.test"]);
  assert.equal(row?.role, "admin", "owned account is promoted to admin");
});

test("node adapter exposes the core query contract", async () => {
  await installNodeAkentrosDbAdapter();
  const query = createAkentrosQuery({ AKENTROS_DB_PATH: ":memory:" });
  assert.equal(typeof query, "function");
  assert.equal(typeof (query as any).transaction, "function");
  const result = await (query as any).transaction(async () => {
    await query("SELECT 1 AS one");
    return "ok";
  });
  assert.equal(result, "ok");
});
