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
    [1, 2, 3, 4],
  );
  // v1:完整 canonical schema(SQLite 方言;時間戳以 strftime 對齊 ISO 格式)。
  assert.match(AKENTROS_MIGRATIONS[0].statements.join("\n"), /CREATE TABLE IF NOT EXISTS ai_requests/);
  assert.match(AKENTROS_MIGRATIONS[0].statements.join("\n"), /strftime\('%Y-%m-%dT%H:%M:%fZ','now'\)/);
  assert.match(AKENTROS_MIGRATIONS[0].statements.join("\n"), /idx_ai_requests_key_idempotency/);
  // v2:分散式 IP 限流視窗表。
  assert.match(AKENTROS_MIGRATIONS[1].statements[0], /akentros_ip_rate_limit_windows/);
  // v3:冪等重放儲存(金鑰 TTL 欄位 + 回應落地表)。
  assert.match(AKENTROS_MIGRATIONS[2].statements.join("\n"), /idempotency_replay_ttl_seconds/);
  assert.match(
    AKENTROS_MIGRATIONS[2].statements.join("\n"),
    /CREATE TABLE IF NOT EXISTS ai_idempotency_replays/,
  );
  assert.match(AKENTROS_MIGRATIONS[2].statements.join("\n"), /idx_ai_idempotency_replays_key/);
  // v4:伺服端會話撤銷(users.session_epoch;users 由 gateway 層
  // ensureUsersSchema 先建 —— sqliteTestDb 已對齊同一順序)。
  assert.match(
    AKENTROS_MIGRATIONS[3].statements.join("\n"),
    /ALTER TABLE users ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0/,
  );
});

// SEC-01 驗收:v3 → v4 升級路徑。既有 v3 部署(users 已存在但沒有
// session_epoch)跑一次遷移 → 只套用 v4,既有列 DEFAULT 0(無 epv 的舊
// token 視為 0,不自動登出既有用戶),重跑冪等。
test("v3 to v4 upgrade adds users.session_epoch without touching existing rows", async () => {
  const { query } = createSqliteTestDb();

  // 模擬既有 v3 部署:完整套用 v1–v3 並記錄版本(users 表由測試 fixture
  // 先建,與 gateway bootstrap 的順序一致)。
  await query(`
    CREATE TABLE IF NOT EXISTS akentros_ai_schema_migrations (
      version INTEGER PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `);
  for (const migration of AKENTROS_MIGRATIONS.filter(({ version }: any) => version <= 3)) {
    for (const statement of migration.statements) {
      await query(statement);
    }
    await query("INSERT INTO akentros_ai_schema_migrations (version, name) VALUES (?, ?)", [
      migration.version,
      migration.name,
    ]);
  }

  // 既有用戶(v3 時代,沒有 epoch 概念)。
  await query(
    "INSERT INTO users (username, email, password_hash, balance_usd_micros) VALUES ('legacy', 'legacy@v3.test', 'x', 1000000)",
  );

  const columnsBefore = await query("SELECT name FROM pragma_table_info('users')");
  assert.equal(
    columnsBefore.rows.some((row: any) => row.name === "session_epoch"),
    false,
    "v3 users table has no session_epoch",
  );

  const result = await migrateAkentrosSchema(query);
  assert.deepEqual(result, { version: AKENTROS_SCHEMA_VERSION, migrated: true });

  const columnsAfter = await query("SELECT name FROM pragma_table_info('users')");
  assert.equal(
    columnsAfter.rows.some((row: any) => row.name === "session_epoch"),
    true,
    "v4 adds users.session_epoch",
  );

  // 既有列 DEFAULT 0:舊 token(無 epv)視為 0,過渡期不自動登出。
  const legacy = await query("SELECT session_epoch FROM users WHERE email = 'legacy@v3.test'");
  assert.equal(Number(legacy.rows[0].session_epoch), 0);

  // 升級後重跑不再遷移(冪等,不重複 ALTER)。
  const again = await migrateAkentrosSchema(query);
  assert.deepEqual(again, { version: AKENTROS_SCHEMA_VERSION, migrated: false });
});
