import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// Node 自架部署的 SQLite adapter:以 Node 內建的 node:sqlite 實作
// (sql, params) => { rows } 查詢介面,供 API server 與 migrate/reconcile
// scripts 共用。此模組只應由 Node 進入點透過 installNodeBeaconDbAdapter()
// 動態載入;Cloudflare Workers 部署改用 src/worker/doDb.ts,worker 打包
// 不得把本檔(連同 node:sqlite)拉進 bundle。
//
// 慣例:
// - 時間戳一律以「UTC ISO-8601 字串」(含毫秒)存入 TEXT 欄位,並以字串
//   比較;DDL 預設值用 strftime('%Y-%m-%dT%H:%M:%fZ','now') 對齊同一格式。
// - 布林以 1/0 儲存;JSON 欄位以 TEXT 存 JSON 字串。
// - 多語句原子性透過 transaction(fn):BEGIN IMMEDIATE 起點,配合
//   AsyncLocalStorage 讓交易內的 query 直連、交易外的查詢排隊等 COMMIT,
//   避免單一連線下其他請求的語句混入交易。

type QueryResult = { rows: any[] };

const databases = new Map<string, DatabaseSync>();
const txStorage = new AsyncLocalStorage<{ depth: number }>();

function resolveDatabasePath(env: any): string {
  const configured = String(env?.BEACON_DB_PATH || env?.DATABASE_URL || "").trim();
  if (!configured || configured.startsWith("sqlite://") || configured.startsWith("file:")) {
    const bare = configured.replace(/^(sqlite:\/\/|sqlite:\/\/\/|file:\/?)/, "");
    return decodeURIComponent(bare) || "beacon.db";
  }
  return configured;
}

function databaseFor(env: any): DatabaseSync {
  const file = resolveDatabasePath(env);
  let database = databases.get(file);
  if (!database) {
    if (file !== ":memory:") {
      fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    }
    database = new DatabaseSync(file);
    // WAL 讓讀寫並行;busy_timeout 在鎖競爭時等待而非立即報錯。
    database.exec("PRAGMA journal_mode = WAL;");
    database.exec("PRAGMA busy_timeout = 5000;");
    database.exec("PRAGMA foreign_keys = ON;");
    databases.set(file, database);
  }
  return database;
}

function normalizeParam(value: any): string | number | bigint | null {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (Array.isArray(value)) return JSON.stringify(value);
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  // node:sqlite 預設把 JS number 綁成 REAL;整數值改綁 INTEGER,
  // 避免微美元等整數欄位落成 '5.0' 這類帶小數的文字。
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  return value;
}

function statementReturnsRows(sql: string): boolean {
  // SELECT / WITH(讀取 CTE)一定回傳列;INSERT/UPDATE … RETURNING 也要
  // 用 all() 才拿得到結果列。
  if (/^\s*(SELECT|WITH)\b/i.test(sql)) return true;
  return /\bRETURNING\b/i.test(sql);
}

function executeQuery(database: DatabaseSync, sql: string, params: any[]): QueryResult {
  const statement = database.prepare(sql);
  const bound = params.map(normalizeParam);
  // RETURNING 語句必須用 all();node:sqlite 的 run() 不回傳列。
  if (statementReturnsRows(sql)) {
    return { rows: statement.all(...bound) as any[] };
  }
  statement.run(...bound);
  return { rows: [] };
}

const pendingByDatabase = new Map<string, Array<() => void>>();
const txOpenByDatabase = new Set<string>();

function flushPending(file: string) {
  const queue = pendingByDatabase.get(file) || [];
  pendingByDatabase.set(file, []);
  while (queue.length) {
    const job = queue.shift();
    job?.();
  }
}

export async function dbQuery(env: any, sql: string, params: any[] = []): Promise<QueryResult> {
  const tx = txStorage.getStore();
  if (tx) {
    // 交易內:同一連線同步執行,單一 Node 執行緒保證不交錯。
    return executeQuery(databaseFor(env), sql, params);
  }

  const file = resolveDatabasePath(env);
  if (txOpenByDatabase.has(file)) {
    // 其他請求的交易進行中:排隊,等 COMMIT 後再執行。
    return new Promise((resolve, reject) => {
      const queue = pendingByDatabase.get(file) || [];
      queue.push(() => {
        try {
          resolve(executeQuery(databaseFor(env), sql, params));
        } catch (error) {
          reject(error);
        }
      });
      pendingByDatabase.set(file, queue);
    });
  }

  return executeQuery(databaseFor(env), sql, params);
}

// 交易封裝:BEGIN IMMEDIATE → fn 內的 query 直連 → COMMIT / ROLLBACK。
// 交易進行中,同資料庫的其他查詢會被擋到交易結束,避免語句混入。
export async function withBeaconTransaction<T>(env: any, fn: () => Promise<T>): Promise<T> {
  const outer = txStorage.getStore();
  if (outer) {
    // 巢狀呼叫:沿用外層交易。
    return fn();
  }
  const database = databaseFor(env);
  const file = resolveDatabasePath(env);
  txOpenByDatabase.add(file);
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = await txStorage.run({ depth: 1 }, fn);
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // 交易已被中斷(如語句失敗自動 rollback)。
    }
    throw error;
  } finally {
    txOpenByDatabase.delete(file);
    flushPending(file);
  }
}

export async function dbGet(env: any, sql: string, params: any[] = []): Promise<any | null> {
  const { rows } = await dbQuery(env, sql, params);
  return rows[0] ?? null;
}

// 給 core store 用的查詢物件:可呼叫 (sql, params),並帶 transaction(fn)
// 讓 core 的多語句原子操作走 SQLite 交易。
export function createBeaconQuery(env: any) {
  const query = (sql: string, params: any[] = []) => dbQuery(env, sql, params);
  (query as any).transaction = (fn: () => Promise<any>) => withBeaconTransaction(env, fn);
  return query;
}

// scripts 結束時釋放連線(保留既有匯出名稱,呼叫點不必改)。
export async function closePostgresClients(): Promise<void> {
  for (const database of databases.values()) {
    try {
      database.close();
    } catch {
      // 已關閉的連線忽略。
    }
  }
  databases.clear();
}
