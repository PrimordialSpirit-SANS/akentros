import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  AKENTROS_MIGRATIONS,
  AKENTROS_SCHEMA_VERSION,
  isAkentrosSchemaReady,
  migrateAkentrosSchema,
} from "../src/schemaMigration.ts";
import { createSqliteTestDb } from "./sqliteTestDb.ts";

test("schema readiness requires the versioned migration on a real SQLite database", async () => {
  const fresh = createSqliteTestDb();
  assert.equal(await isAkentrosSchemaReady(fresh.query), false);

  const migrated = createSqliteTestDb();
  await migrateAkentrosSchema(migrated.query);
  assert.equal(await isAkentrosSchemaReady(migrated.query), true);
});

test("migration runner records every version and verifies readiness", async () => {
  const { query } = createSqliteTestDb();
  const result = await migrateAkentrosSchema(query);
  assert.deepEqual(result, { version: AKENTROS_SCHEMA_VERSION, migrated: true });

  const versions = await query(`SELECT version FROM akentros_ai_schema_migrations ORDER BY version`);
  assert.deepEqual(
    versions.rows.map((row: any) => Number(row.version)),
    AKENTROS_MIGRATIONS.map(({ version }: any) => version),
  );

  const idempotencyIndex = await query(
    `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_ai_requests_key_idempotency'`,
  );
  assert.equal(idempotencyIndex.rows.length, 1);

  // 重跑不再遷移。
  const again = await migrateAkentrosSchema(query);
  assert.deepEqual(again, { version: AKENTROS_SCHEMA_VERSION, migrated: false });
});

test("SQLite migrations define the canonical schema and the IP rate-limit windows", () => {
  const workerAdapter = readFileSync(
    new URL("../../../apps/gateway/src/utils/aiSchema.ts", import.meta.url),
    "utf8",
  );
  assert.match(workerAdapter, /assertAkentrosSchemaReady/);
  assert.doesNotMatch(workerAdapter, /migrateAkentrosSchema/);
  assert.match(workerAdapter, /const schemaPromises = new Map\(\)/);
  assert.doesNotMatch(workerAdapter, /CREATE TABLE IF NOT EXISTS ai_/);
  const migrationScript = readFileSync(
    new URL("../../../apps/gateway/scripts/migrateAkentros.ts", import.meta.url),
    "utf8",
  );
  // migrate script 與 Workers DO 首次啟動共用 bootstrap 流程。
  assert.match(migrationScript, /ensureAkentrosSchemaReady/);
  assert.match(migrationScript, /seedAkentrosAdminFromEnv/);
  const bootstrap = readFileSync(
    new URL("../../../apps/gateway/src/utils/bootstrap.ts", import.meta.url),
    "utf8",
  );
  assert.match(bootstrap, /migrateAkentrosSchema/);
  assert.match(bootstrap, /ensureLedgerSchema/);
  assert.match(bootstrap, /ensureUsersSchema/);
  assert.equal(Object.isFrozen(AKENTROS_MIGRATIONS), true);
  assert.deepEqual(
    AKENTROS_MIGRATIONS.map(({ version }: any) => version),
    [1, 2],
  );
  // v1:完整 canonical schema(SQLite 方言;時間戳以 strftime 對齊 ISO 格式)。
  assert.match(AKENTROS_MIGRATIONS[0].statements.join("\n"), /CREATE TABLE IF NOT EXISTS ai_requests/);
  assert.match(AKENTROS_MIGRATIONS[0].statements.join("\n"), /strftime\('%Y-%m-%dT%H:%M:%fZ','now'\)/);
  assert.match(AKENTROS_MIGRATIONS[0].statements.join("\n"), /idx_ai_requests_key_idempotency/);
  // v2:分散式 IP 限流視窗表。
  assert.match(AKENTROS_MIGRATIONS[1].statements[0], /akentros_ip_rate_limit_windows/);
});
