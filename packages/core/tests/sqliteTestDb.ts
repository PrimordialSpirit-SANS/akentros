import { DatabaseSync } from "node:sqlite";

// 測試用的真實 SQLite in-memory 查詢物件:與 apps/gateway/src/utils/db.ts
// 相同的 (sql, params) => { rows } 介面與 transaction(fn) 語義,
// 讓 core 的行為測試直接驗證 SQL 正確性,而不是假 query。
// 先在此建立 ledger_entries 與 users(與 gateway 層 DDL 一致),
// 其餘 ai_* 資料表由 migrateBeaconSchema 建。

export function createSqliteTestDb() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON;");

  const NOW_DEFAULT_SQL = "TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))";
  database.exec(`
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
      created_at ${NOW_DEFAULT_SQL}
    );
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      balance_usd_micros INTEGER NOT NULL DEFAULT 0,
      is_banned INTEGER NOT NULL DEFAULT 0,
      is_flagged INTEGER NOT NULL DEFAULT 0,
      restricted_services TEXT NOT NULL DEFAULT '[]',
      display_name TEXT NOT NULL DEFAULT '',
      created_at ${NOW_DEFAULT_SQL},
      updated_at ${NOW_DEFAULT_SQL}
    );
  `);

  function normalizeParam(value: any): string | number | bigint | null {
    if (value === undefined) return null;
    if (typeof value === "boolean") return value ? 1 : 0;
    if (Array.isArray(value)) return JSON.stringify(value);
    if (value !== null && typeof value === "object") return JSON.stringify(value);
    // 與 gateway 适配器一致:安全整數綁 INTEGER,避免 REAL 化。
    if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
    return value;
  }

  function statementReturnsRows(sql: string): boolean {
    if (/^\s*(SELECT|WITH)\b/i.test(sql)) return true;
    return /\bRETURNING\b/i.test(sql);
  }

  const query: any = (sql: string, params: any[] = []) => {
    const statement = database.prepare(sql);
    const bound = params.map(normalizeParam);
    if (statementReturnsRows(sql)) {
      return Promise.resolve({ rows: statement.all(...bound) });
    }
    statement.run(...bound);
    return Promise.resolve({ rows: [] });
  };

  query.transaction = async (fn: () => Promise<any>) => {
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = await fn();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // 交易已中斷。
      }
      throw error;
    }
  };

  const insertUser = (overrides: any = {}) => {
    const row = {
      username: "tester",
      email: `user-${Math.random().toString(36).slice(2)}@test.local`,
      balance_usd_micros: 100_000_000,
      ...overrides,
    };
    const result = database
      .prepare(
        `INSERT INTO users (username, email, password_hash, balance_usd_micros) VALUES (?, ?, 'x', ?) RETURNING id`,
      )
      .all(row.username, row.email, row.balance_usd_micros) as any[];
    return { id: String(result[0].id), ...row };
  };

  return { database, query, insertUser };
}
