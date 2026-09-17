import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { BeaconRuntimeEnv } from "../types.ts";

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

// 相對 DB 路徑的錨點:gateway 套件目錄(apps/gateway/),與 process.cwd()
// 無關。根目錄 script(npm run dev:gateway / start:gateway 由 repo 根執行)
// 與 workspace script(npm run migrate 在 apps/gateway 內執行)的 cwd 不同;
// 若以 cwd 解析 BEACON_DB_PATH=./beacon.db,兩者會開到不同的檔案——
// migrate 成功、server 卻 no such table: users。
const GATEWAY_PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * 解析 SQLite 資料庫檔案路徑。相對路徑(含 sqlite://、file: 前綴剝離後的
 * 相對路徑)一律錨定在 gateway 套件目錄;絕對路徑與 `:memory:` 維持原義。
 * 匯出供測試釘死 cwd 不變式。
 */
export function resolveDatabasePath(env: BeaconRuntimeEnv): string {
  const configured = String(env?.BEACON_DB_PATH || env?.DATABASE_URL || "").trim();
  let candidate = configured;
  // sqlite:// 剝到雙斜線為止,file: 只剝 scheme:三斜線 URI(file:///var/…)
  // 的第三條斜線是路徑根,剝掉會把絕對路徑誤判成相對路徑。
  if (!candidate || candidate.startsWith("sqlite://") || candidate.startsWith("file:")) {
    candidate = decodeURIComponent(candidate.replace(/^(?:sqlite:\/\/|file:)/, "")) || "beacon.db";
  }
  if (candidate === ":memory:") return candidate;
  if (path.isAbsolute(candidate)) return candidate;
  return path.join(GATEWAY_PACKAGE_ROOT, candidate);
}

const databases = new Map<string, DatabaseSync>();
const txStorage = new AsyncLocalStorage<{ depth: number }>();

function databaseFor(env: BeaconRuntimeEnv): DatabaseSync {
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

export async function dbQuery(env: BeaconRuntimeEnv, sql: string, params: any[] = []): Promise<QueryResult> {
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
export async function withBeaconTransaction<T>(env: BeaconRuntimeEnv, fn: () => Promise<T>): Promise<T> {
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

export async function dbGet(env: BeaconRuntimeEnv, sql: string, params: any[] = []): Promise<any | null> {
  const { rows } = await dbQuery(env, sql, params);
  return rows[0] ?? null;
}

// 給 core store 用的查詢物件:可呼叫 (sql, params),並帶 transaction(fn)
// 讓 core 的多語句原子操作走 SQLite 交易。
export function createBeaconQuery(env: BeaconRuntimeEnv) {
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
