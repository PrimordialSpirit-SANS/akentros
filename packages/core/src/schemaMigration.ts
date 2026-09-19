import { AKENTROS_SCHEMA_VERSION, isAkentrosSchemaReady } from "./schemaReadiness.ts";

export {
  assertAkentrosSchemaReady,
  AKENTROS_SCHEMA_VERSION,
  isAkentrosSchemaReady,
  REQUIRED_AKENTROS_COLUMNS,
  REQUIRED_AKENTROS_INDEXES,
} from "./schemaReadiness.ts";

// SQLite 方言。時間戳一律 TEXT 存 UTC ISO-8601(含毫秒),預設值以
// strftime 對齊同一格式;布林以 INTEGER 1/0;JSON 以 TEXT。
const NOW_DEFAULT_SQL = "TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))";

const MIGRATION_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS akentros_ai_schema_migrations (
    version INTEGER PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    applied_at ${NOW_DEFAULT_SQL}
  )
`;

const CANONICAL_TABLES = Object.freeze([
  `CREATE TABLE IF NOT EXISTS ai_api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name VARCHAR(80) NOT NULL,
    environment VARCHAR(16) NOT NULL DEFAULT 'live',
    key_prefix VARCHAR(32) NOT NULL,
    key_suffix VARCHAR(8) NOT NULL,
    key_digest CHAR(64) NOT NULL UNIQUE,
    scopes TEXT NOT NULL DEFAULT '["chat:completions","models:read"]',
    model_allowlist TEXT NOT NULL DEFAULT '[]',
    rpm_limit INTEGER NOT NULL DEFAULT 60,
    max_in_flight INTEGER NOT NULL DEFAULT 4,
    spend_limit_usd_micros INTEGER NULL,
    spend_used_usd_micros INTEGER NOT NULL DEFAULT 0,
    spend_reserved_usd_micros INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    expires_at TEXT NULL,
    last_used_at TEXT NULL,
    rotated_at TEXT NULL,
    revoked_at TEXT NULL,
    created_at ${NOW_DEFAULT_SQL},
    updated_at ${NOW_DEFAULT_SQL}
  )`,
  `CREATE TABLE IF NOT EXISTS ai_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id VARCHAR(80) NOT NULL UNIQUE,
    user_id INTEGER NOT NULL,
    api_key_id INTEGER NOT NULL,
    idempotency_key VARCHAR(200) NULL,
    request_fingerprint CHAR(64) NOT NULL,
    endpoint VARCHAR(80) NOT NULL DEFAULT 'chat.completions',
    stream INTEGER NOT NULL DEFAULT 0,
    public_model VARCHAR(200) NOT NULL,
    provider VARCHAR(40) NULL,
    upstream_model VARCHAR(240) NULL,
    route_id VARCHAR(120) NULL,
    pricing_revision VARCHAR(80) NOT NULL,
    pricing_snapshot TEXT NOT NULL,
    input_tokens INTEGER NULL,
    output_tokens INTEGER NULL,
    total_tokens INTEGER NULL,
    usage_source VARCHAR(24) NULL,
    reserved_usd_micros INTEGER NOT NULL DEFAULT 0,
    charged_usd_micros INTEGER NOT NULL DEFAULT 0,
    refunded_usd_micros INTEGER NOT NULL DEFAULT 0,
    status VARCHAR(40) NOT NULL DEFAULT 'reserved',
    error_code VARCHAR(80) NULL,
    http_status INTEGER NULL,
    upstream_request_id VARCHAR(200) NULL,
    first_token_ms INTEGER NULL,
    total_latency_ms INTEGER NULL,
    dispatched_at TEXT NULL,
    finalized_at TEXT NULL,
    created_at ${NOW_DEFAULT_SQL},
    updated_at ${NOW_DEFAULT_SQL}
  )`,
  `CREATE TABLE IF NOT EXISTS ai_provider_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ai_request_id INTEGER NOT NULL,
    request_id VARCHAR(80) NOT NULL,
    attempt_number INTEGER NOT NULL,
    provider VARCHAR(40) NOT NULL,
    pool_id VARCHAR(120) NOT NULL,
    credential_id VARCHAR(160) NULL,
    route_id VARCHAR(120) NOT NULL,
    upstream_model VARCHAR(240) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'started',
    http_status INTEGER NULL,
    error_category VARCHAR(80) NULL,
    upstream_request_id VARCHAR(200) NULL,
    latency_ms INTEGER NULL,
    started_at ${NOW_DEFAULT_SQL},
    finished_at TEXT NULL,
    UNIQUE (ai_request_id, attempt_number)
  )`,
  `CREATE TABLE IF NOT EXISTS ai_provider_credentials (
    credential_id VARCHAR(160) PRIMARY KEY,
    provider VARCHAR(40) NOT NULL,
    pool_id VARCHAR(120) NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    weight INTEGER NOT NULL DEFAULT 1,
    max_in_flight INTEGER NOT NULL DEFAULT 4,
    in_flight INTEGER NOT NULL DEFAULT 0,
    selection_count INTEGER NOT NULL DEFAULT 0,
    state VARCHAR(40) NOT NULL DEFAULT 'healthy',
    cooldown_until TEXT NULL,
    lease_expires_at TEXT NULL,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    successful_requests INTEGER NOT NULL DEFAULT 0,
    failed_requests INTEGER NOT NULL DEFAULT 0,
    ewma_latency_ms REAL NULL,
    last_selected_at TEXT NULL,
    last_success_at TEXT NULL,
    last_failure_at TEXT NULL,
    last_error_code VARCHAR(100) NULL,
    quota_remaining TEXT NULL,
    updated_at ${NOW_DEFAULT_SQL}
  )`,
  `CREATE TABLE IF NOT EXISTS ai_provider_credential_leases (
    lease_id VARCHAR(80) PRIMARY KEY,
    request_id VARCHAR(80) NOT NULL,
    credential_id VARCHAR(160) NOT NULL,
    expires_at TEXT NOT NULL,
    released_at TEXT NULL,
    created_at ${NOW_DEFAULT_SQL}
  )`,
  `CREATE TABLE IF NOT EXISTS ai_billing_reservations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ai_request_id INTEGER NOT NULL UNIQUE,
    request_id VARCHAR(80) NOT NULL,
    user_id INTEGER NOT NULL,
    reserved_usd_micros INTEGER NOT NULL,
    charged_usd_micros INTEGER NOT NULL DEFAULT 0,
    refunded_usd_micros INTEGER NOT NULL DEFAULT 0,
    state VARCHAR(40) NOT NULL DEFAULT 'reserved',
    expires_at TEXT NOT NULL,
    settled_at TEXT NULL,
    created_at ${NOW_DEFAULT_SQL},
    updated_at ${NOW_DEFAULT_SQL}
  )`,
  `CREATE TABLE IF NOT EXISTS ai_rate_limit_buckets (
    api_key_id INTEGER NOT NULL,
    window_start TEXT NOT NULL,
    request_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (api_key_id, window_start)
  )`,
  `CREATE TABLE IF NOT EXISTS ai_api_inflight_leases (
    request_id VARCHAR(80) PRIMARY KEY,
    api_key_id INTEGER NOT NULL,
    expires_at TEXT NOT NULL,
    released_at TEXT NULL,
    created_at ${NOW_DEFAULT_SQL}
  )`,
]);

const CANONICAL_INDEXES = Object.freeze([
  `CREATE INDEX IF NOT EXISTS idx_ai_api_keys_user_created ON ai_api_keys (user_id, created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_api_keys_digest_active ON ai_api_keys (key_digest, is_active)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_requests_key_idempotency
   ON ai_requests (api_key_id, idempotency_key) WHERE idempotency_key IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_ai_requests_user_created ON ai_requests (user_id, created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_requests_status_created ON ai_requests (status, created_at, id)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_provider_attempts_request ON ai_provider_attempts (ai_request_id, attempt_number)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_provider_pool_health
   ON ai_provider_credentials (pool_id, enabled, state, cooldown_until)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_provider_leases_active
   ON ai_provider_credential_leases (credential_id, expires_at) WHERE released_at IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_billing_request_id
   ON ai_billing_reservations (request_id) WHERE request_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_ai_billing_state_expiry ON ai_billing_reservations (state, expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_api_inflight_active
   ON ai_api_inflight_leases (api_key_id, expires_at) WHERE released_at IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_entries_akentros_ai_reservation
   ON ledger_entries (source_id, transaction_type)
   WHERE source_type = 'akentros_ai' AND transaction_type = 'ai_usage_reservation'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_entries_akentros_ai_refund
   ON ledger_entries (source_id, transaction_type)
   WHERE source_type = 'akentros_ai' AND transaction_type = 'ai_usage_refund'`,
]);

// 版本歷史:PostgreSQL 時代的 v1–v7(legacy 修復、計費指紋、免費額度桶、
// IP 限流視窗)在 SQLite 方言下是全新資料庫,legacy 修復不適用,因此版本
// 歷史重置:v1 = 完整 canonical schema,v2 = 分散式 IP 限流視窗表。
// PostgreSQL 並行版的歷史請參閱 Git 歷史。
export const AKENTROS_MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 1,
    name: "canonical-runtime-schema-sqlite",
    statements: Object.freeze([...CANONICAL_TABLES, ...CANONICAL_INDEXES]),
  }),
  Object.freeze({
    version: 2,
    name: "distributed-ip-rate-limit-windows",
    statements: Object.freeze([
      // 登入/金鑰管理端點的 IP 限流:固定窗口計數,跨請求全域生效。
      // 每個 identity 只保留當前窗口一列;窗口滾動由 upsert 歸零,舊列由
      // middleware 的 sweep 語句背景清理。
      `CREATE TABLE IF NOT EXISTS akentros_ip_rate_limit_windows (
        identity VARCHAR(160) PRIMARY KEY,
        window_start TEXT NOT NULL,
        hit_count INTEGER NOT NULL DEFAULT 0
      )`,
    ]),
  }),
]);

function rows(result: any): any[] {
  return Array.isArray(result?.rows) ? result.rows : [];
}

export async function migrateAkentrosSchema(query: any) {
  if (typeof query !== "function") {
    throw new TypeError("migrateAkentrosSchema requires a database query function.");
  }

  if (await isAkentrosSchemaReady(query)) {
    return { version: AKENTROS_SCHEMA_VERSION, migrated: false };
  }

  await query(MIGRATION_TABLE_SQL);
  for (const migration of AKENTROS_MIGRATIONS) {
    const alreadyRecorded = await query("SELECT version FROM akentros_ai_schema_migrations WHERE version = ?", [
      migration.version,
    ]);
    if (rows(alreadyRecorded).length) continue;
    for (const statement of migration.statements) {
      await query(statement);
    }
    const recorded = await query(
      "INSERT INTO akentros_ai_schema_migrations (version, name) VALUES (?, ?) " +
        "ON CONFLICT (version) DO UPDATE SET " +
        "name = EXCLUDED.name " +
        "RETURNING version",
      [migration.version, migration.name],
    );
    if (Number(rows(recorded)[0]?.version || 0) !== migration.version) {
      throw new Error(`Akentros schema migration ${migration.version} was not recorded.`);
    }
  }

  if (!(await isAkentrosSchemaReady(query))) {
    throw new Error("Akentros schema migration did not produce the required columns and indexes.");
  }
  return { version: AKENTROS_SCHEMA_VERSION, migrated: true };
}
