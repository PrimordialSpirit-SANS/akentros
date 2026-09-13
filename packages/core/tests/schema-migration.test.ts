import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  BEACON_MIGRATIONS,
  BEACON_SCHEMA_VERSION,
  isBeaconSchemaReady,
  migrateBeaconSchema,
} from "../src/schemaMigration.ts";
import { createSqliteTestDb } from "./sqliteTestDb.ts";

test("schema readiness requires the versioned migration on a real SQLite database", async () => {
  const fresh = createSqliteTestDb();
  assert.equal(await isBeaconSchemaReady(fresh.query), false);

  const migrated = createSqliteTestDb();
  await migrateBeaconSchema(migrated.query);
  assert.equal(await isBeaconSchemaReady(migrated.query), true);
});

test("migration runner records every version and verifies readiness", async () => {
  const { query } = createSqliteTestDb();
  const result = await migrateBeaconSchema(query);
  assert.deepEqual(result, { version: BEACON_SCHEMA_VERSION, migrated: true });

  const versions = await query(`SELECT version FROM beacon_ai_schema_migrations ORDER BY version`);
  assert.deepEqual(
    versions.rows.map((row: any) => Number(row.version)),
    BEACON_MIGRATIONS.map(({ version }: any) => version),
  );

  const idempotencyIndex = await query(
    `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_ai_requests_key_idempotency'`,
  );
  assert.equal(idempotencyIndex.rows.length, 1);

  // 重跑不再遷移。
  const again = await migrateBeaconSchema(query);
  assert.deepEqual(again, { version: BEACON_SCHEMA_VERSION, migrated: false });
});

test("SQLite migrations define the canonical schema and the IP rate-limit windows", () => {
  const workerAdapter = readFileSync(
    new URL("../../../apps/gateway/src/utils/aiSchema.ts", import.meta.url),
    "utf8",
  );
  assert.match(workerAdapter, /assertBeaconSchemaReady/);
  assert.doesNotMatch(workerAdapter, /migrateBeaconSchema/);
  assert.match(workerAdapter, /const schemaPromises = new Map\(\)/);
  assert.doesNotMatch(workerAdapter, /CREATE TABLE IF NOT EXISTS ai_/);
  const migrationScript = readFileSync(
    new URL("../../../apps/gateway/scripts/migrateBeacon.ts", import.meta.url),
    "utf8",
  );
  // migrate script 與 Workers DO 首次啟動共用 bootstrap 流程。
  assert.match(migrationScript, /ensureBeaconSchemaReady/);
  assert.match(migrationScript, /seedBeaconAdminFromEnv/);
  const bootstrap = readFileSync(
    new URL("../../../apps/gateway/src/utils/bootstrap.ts", import.meta.url),
    "utf8",
  );
  assert.match(bootstrap, /migrateBeaconSchema/);
  assert.match(bootstrap, /ensureLedgerSchema/);
  assert.match(bootstrap, /ensureUsersSchema/);
  assert.equal(Object.isFrozen(BEACON_MIGRATIONS), true);
  assert.deepEqual(
    BEACON_MIGRATIONS.map(({ version }: any) => version),
    [1, 2],
  );
  // v1:完整 canonical schema(SQLite 方言;時間戳以 strftime 對齊 ISO 格式)。
  assert.match(BEACON_MIGRATIONS[0].statements.join("\n"), /CREATE TABLE IF NOT EXISTS ai_requests/);
  assert.match(BEACON_MIGRATIONS[0].statements.join("\n"), /strftime\('%Y-%m-%dT%H:%M:%fZ','now'\)/);
  assert.match(BEACON_MIGRATIONS[0].statements.join("\n"), /idx_ai_requests_key_idempotency/);
  // v2:分散式 IP 限流視窗表。
  assert.match(BEACON_MIGRATIONS[1].statements[0], /beacon_ip_rate_limit_windows/);
});
