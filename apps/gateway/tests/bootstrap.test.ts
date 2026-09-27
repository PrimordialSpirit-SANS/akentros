import assert from "node:assert/strict";
import test from "node:test";
import { assertAkentrosSchemaReady } from "@akentros/core/schemaReadiness";
import { ensureAkentrosSchemaReady, seedAkentrosAdminFromEnv } from "../src/utils/bootstrap.ts";
import { createAkentrosQuery, dbGet, dbQuery, installNodeAkentrosDbAdapter } from "../src/utils/db.ts";

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
