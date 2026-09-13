import { dbQuery } from "./db.ts";

// 平台層的點數流水帳。Beacon 的計費保留/退款會寫入此表,
// schemaMigration.ts 的部分唯一索引也建立在它之上,所以必須先於 AI schema 存在。
// 欄位集合以 packages/core/src/billing.ts 的 INSERT 為準。

export async function ensureLedgerSchema(env: any): Promise<void> {
  await dbQuery(
    env,
    `
    CREATE TABLE IF NOT EXISTS ledger_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      user_name TEXT NOT NULL DEFAULT '',
      user_email TEXT NOT NULL DEFAULT '',
      direction TEXT NOT NULL,
      amount TEXT NOT NULL,
      balance_before TEXT NOT NULL,
      balance_after TEXT NOT NULL,
      transaction_type TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      idempotency_key TEXT,
      description TEXT NOT NULL DEFAULT '',
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `,
  );
  await dbQuery(
    env,
    `
    CREATE INDEX IF NOT EXISTS idx_ledger_entries_user_created
    ON ledger_entries (user_id, created_at DESC)
  `,
  );
  await dbQuery(
    env,
    `
    CREATE INDEX IF NOT EXISTS idx_ledger_entries_source
    ON ledger_entries (source_type, source_id)
  `,
  );
  // 與 schemaMigration.ts CANONICAL_INDEXES 相同的冪等索引:
  await dbQuery(
    env,
    `
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_entries_beacon_ai_reservation
    ON ledger_entries (source_id, transaction_type)
    WHERE source_type = 'beacon_ai' AND transaction_type = 'ai_usage_reservation'
  `,
  );
  await dbQuery(
    env,
    `
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_entries_beacon_ai_refund
    ON ledger_entries (source_id, transaction_type)
    WHERE source_type = 'beacon_ai' AND transaction_type = 'ai_usage_refund'
  `,
  );
}
