import assert from "node:assert/strict";
import test from "node:test";
import { assertBeaconSchemaReady } from "@beacon/core/schemaReadiness";
import { ensureBeaconSchemaReady, seedBeaconAdminFromEnv } from "../src/utils/bootstrap.ts";
import { createBeaconQuery, dbGet, dbQuery, installNodeBeaconDbAdapter } from "../src/utils/db.ts";

// Node adapter(node:sqlite)對共用的 bootstrap 流程做真實端到端驗證:
// Workers DO 首次啟動跑的是同一份 ensureBeaconSchemaReady/seedBeaconAdminFromEnv。

test("bootstrap migrates schema and seeds admin idempotently", async () => {
  await installNodeBeaconDbAdapter();

  const env = {
    BEACON_DB_PATH: ":memory:",
    ADMIN_EMAIL: "admin@example.com",
    ADMIN_PASSWORD: "correct horse battery",
  };

  const first = await ensureBeaconSchemaReady(env);
  assert.equal(first.migrated, true, "first run should apply pending migrations");
  await assertBeaconSchemaReady((sql: any, params: any[] = []) => dbQuery(env, sql, params));

  const seededFirst = await seedBeaconAdminFromEnv(env);
  assert.equal(seededFirst?.created, true);
  const admin = await dbGet(env, "SELECT email, role FROM users WHERE email = ?", ["admin@example.com"]);
  assert.equal(admin?.email, "admin@example.com");

  const second = await ensureBeaconSchemaReady(env);
  assert.equal(second.migrated, false, "second run should find schema already ready");
  const seededSecond = await seedBeaconAdminFromEnv(env);
  assert.equal(seededSecond?.created, false, "admin seed is idempotent");
});

test("bootstrap skips admin seed without ADMIN_EMAIL/ADMIN_PASSWORD", async () => {
  await installNodeBeaconDbAdapter();
  const seeded = await seedBeaconAdminFromEnv({ BEACON_DB_PATH: ":memory:" });
  assert.equal(seeded, null);
});

test("node adapter exposes the core query contract", async () => {
  await installNodeBeaconDbAdapter();
  const query = createBeaconQuery({ BEACON_DB_PATH: ":memory:" });
  assert.equal(typeof query, "function");
  assert.equal(typeof (query as any).transaction, "function");
  const result = await (query as any).transaction(async () => {
    await query("SELECT 1 AS one");
    return "ok";
  });
  assert.equal(result, "ok");
});
