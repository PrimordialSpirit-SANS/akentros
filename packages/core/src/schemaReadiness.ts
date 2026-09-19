export const AKENTROS_SCHEMA_VERSION = 3;

function freezeRecord(record: Record<string, string[]>) {
  return Object.freeze(
    Object.fromEntries(Object.entries(record).map(([key, values]) => [key, Object.freeze([...values])])),
  );
}

export const REQUIRED_AKENTROS_COLUMNS = freezeRecord({
  ai_api_keys: [
    "id",
    "user_id",
    "name",
    "environment",
    "key_prefix",
    "key_suffix",
    "key_digest",
    "scopes",
    "model_allowlist",
    "rpm_limit",
    "max_in_flight",
    "spend_limit_usd_micros",
    "spend_used_usd_micros",
    "spend_reserved_usd_micros",
    "idempotency_replay_ttl_seconds",
    "is_active",
    "expires_at",
    "last_used_at",
    "rotated_at",
    "revoked_at",
    "created_at",
    "updated_at",
  ],
  ai_requests: [
    "id",
    "request_id",
    "user_id",
    "api_key_id",
    "idempotency_key",
    "request_fingerprint",
    "endpoint",
    "stream",
    "public_model",
    "provider",
    "upstream_model",
    "route_id",
    "pricing_revision",
    "pricing_snapshot",
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "usage_source",
    "reserved_usd_micros",
    "charged_usd_micros",
    "refunded_usd_micros",
    "status",
    "error_code",
    "http_status",
    "upstream_request_id",
    "replay_of_request_id",
    "first_token_ms",
    "total_latency_ms",
    "dispatched_at",
    "finalized_at",
    "created_at",
    "updated_at",
  ],
  ai_provider_attempts: [
    "id",
    "ai_request_id",
    "request_id",
    "attempt_number",
    "provider",
    "pool_id",
    "credential_id",
    "route_id",
    "upstream_model",
    "status",
    "http_status",
    "error_category",
    "upstream_request_id",
    "latency_ms",
    "started_at",
    "finished_at",
  ],
  ai_provider_credentials: [
    "credential_id",
    "provider",
    "pool_id",
    "enabled",
    "weight",
    "max_in_flight",
    "in_flight",
    "selection_count",
    "state",
    "cooldown_until",
    "lease_expires_at",
    "consecutive_failures",
    "successful_requests",
    "failed_requests",
    "ewma_latency_ms",
    "last_selected_at",
    "last_success_at",
    "last_failure_at",
    "last_error_code",
    "quota_remaining",
    "updated_at",
  ],
  ai_provider_credential_leases: [
    "lease_id",
    "request_id",
    "credential_id",
    "expires_at",
    "released_at",
    "created_at",
  ],
  ai_billing_reservations: [
    "id",
    "ai_request_id",
    "request_id",
    "user_id",
    "reserved_usd_micros",
    "charged_usd_micros",
    "refunded_usd_micros",
    "state",
    "expires_at",
    "settled_at",
    "created_at",
    "updated_at",
  ],
  ai_rate_limit_buckets: ["api_key_id", "window_start", "request_count"],
  ai_api_inflight_leases: ["request_id", "api_key_id", "expires_at", "released_at", "created_at"],
  ai_idempotency_replays: [
    "request_id",
    "api_key_id",
    "idempotency_key",
    "request_fingerprint",
    "endpoint",
    "response_status",
    "content_type",
    "response_payload",
    "payload_bytes",
    "expires_at",
    "created_at",
  ],
});

export const REQUIRED_AKENTROS_INDEXES = Object.freeze([
  "idx_ai_api_keys_user_created",
  "idx_ai_api_keys_digest_active",
  "idx_ai_requests_key_idempotency",
  "idx_ai_requests_user_created",
  "idx_ai_requests_status_created",
  "idx_ai_provider_attempts_request",
  "idx_ai_provider_pool_health",
  "idx_ai_provider_leases_active",
  "idx_ai_billing_request_id",
  "idx_ai_billing_state_expiry",
  "idx_ai_api_inflight_active",
  "idx_ai_idempotency_replays_key",
  "idx_ai_idempotency_replays_expiry",
  "idx_ledger_entries_akentros_ai_reservation",
  "idx_ledger_entries_akentros_ai_refund",
]);

function rows(result: any): any[] {
  return Array.isArray(result?.rows) ? result.rows : [];
}

// 就緒檢查的方言分支:SQLite 以 sqlite_master / pragma_table_info 檢視
// catalog;PostgreSQL 以 information_schema / pg_indexes。兩者回傳的欄位名
// 一致(name / column_name 統一別名為 name),檢查邏輯共用。
function catalogSql(dialect: "postgres" | "sqlite") {
  if (dialect === "postgres") {
    return {
      migrationTableExists: `
    SELECT to_regclass(?) AS name
  `,
      tableColumns: `
    SELECT column_name AS name FROM information_schema.columns
    WHERE table_name = ?
  `,
      indexNames: (placeholders: string) => `
    SELECT indexname AS name FROM pg_indexes WHERE indexname IN (${placeholders})
  `,
    };
  }
  return {
    migrationTableExists: `
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `,
    tableColumns: `
    SELECT name FROM pragma_table_info(?)
  `,
    indexNames: (placeholders: string) => `
    SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (${placeholders})
  `,
  };
}

export async function isAkentrosSchemaReady(query: any) {
  const dialect: "postgres" | "sqlite" = query?.dialect === "postgres" ? "postgres" : "sqlite";
  const catalog = catalogSql(dialect);

  const migrationTable = await query(catalog.migrationTableExists, ["akentros_ai_schema_migrations"]);
  if (!rows(migrationTable)[0]?.name) return false;

  const versionResult = await query(`
    SELECT COALESCE(MAX(version), 0) AS version
    FROM akentros_ai_schema_migrations
  `);
  if (Number(rows(versionResult)[0]?.version || 0) < AKENTROS_SCHEMA_VERSION) return false;

  for (const [table, columns] of Object.entries(REQUIRED_AKENTROS_COLUMNS)) {
    const columnsResult = await query(catalog.tableColumns, [table]);
    const existing = new Set(rows(columnsResult).map((row: any) => String(row.name)));
    for (const column of columns) {
      if (!existing.has(column)) return false;
    }
  }

  const indexPlaceholders = REQUIRED_AKENTROS_INDEXES.map(() => "?").join(", ");
  const indexesResult = await query(catalog.indexNames(indexPlaceholders), [...REQUIRED_AKENTROS_INDEXES]);
  const existingIndexes = new Set(rows(indexesResult).map((row: any) => String(row.name)));
  return REQUIRED_AKENTROS_INDEXES.every((index) => existingIndexes.has(index));
}

export async function assertAkentrosSchemaReady(query: any) {
  if (await isAkentrosSchemaReady(query)) return;
  const error = new Error(
    "Akentros database schema is not ready. Run the versioned Akentros migration before serving requests.",
  ) as Error & { code?: string };
  error.code = "AKENTROS_SCHEMA_NOT_READY";
  throw error;
}
