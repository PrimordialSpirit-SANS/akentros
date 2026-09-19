import { AsyncLocalStorage } from "node:async_hooks";
import type { AkentrosQuery } from "@akentros/core/query";
import pg from "pg";
import type { AkentrosRuntimeEnv } from "../types.ts";

// Node 自架部署的 PostgreSQL adapter:以 pg Pool 實作 (sql, params) => { rows }
// 查詢介面,契約與 db.node.ts 相同。由 db.ts 的 installNodeAkentrosDbAdapter()
// 在 DATABASE_URL 為 postgres(ql):// 時動態載入(非字面量 specifier,Workers
// 打包不會把本檔連同 pg 拉進 bundle)。
//
// 慣例與 SQLite adapter 一致:
// - 時間戳一律 TEXT 存 UTC ISO-8601 字串(含毫秒),以字串比較;DDL 預設值
//   由 schemaMigration 的 PG 方言以 to_char(now() AT TIME ZONE 'UTC', …) 對齊。
// - 布林以 1/0 整數(SQLite 慣例;DDL 的 is_active 等欄位為 INTEGER,
//   避免與「= 1」的既有 SQL 衝突);JSON 欄位以 TEXT 存 JSON 字串。
// - 佔位符:core 的 SQL 以 SQLite 風格「?」撰寫,此處轉換為「$n」。
// - 交易:從 Pool 取出專屬 client,BEGIN … COMMIT/ROLLBACK;交易內的查詢以
//   AsyncLocalStorage 綁定同一 client,交易外的查詢各自向 Pool 借用連線。
//   core 的金錢/限流路徑已以 dialect.rowLock(FOR UPDATE)與 advisory lock
//   補齊 READ COMMITTED 下的序列化保證(見 packages/core/src/sqlDialect.ts)。

export function postgresPlaceholders(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function normalizeParam(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return JSON.stringify(value);
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return value;
}

const pools = new Map<string, pg.Pool>();
const txStorage = new AsyncLocalStorage<{ client: pg.PoolClient }>();

function poolFor(env: AkentrosRuntimeEnv): pg.Pool {
  const connectionString = String(env?.DATABASE_URL || process.env.DATABASE_URL || "").trim();
  let pool = pools.get(connectionString);
  if (!pool) {
    pool = new pg.Pool({
      connectionString: connectionString || undefined,
      max: Number(process.env.AKENTROS_PG_POOL_MAX) > 0 ? Number(process.env.AKENTROS_PG_POOL_MAX) : 10,
    });
    pools.set(connectionString, pool);
  }
  return pool;
}

type QueryResult = { rows: any[] };

async function executeQuery(
  client: pg.PoolClient | pg.Pool,
  sql: string,
  params: unknown[],
): Promise<QueryResult> {
  const result = await client.query(postgresPlaceholders(sql), params.map(normalizeParam));
  return { rows: result.rows as any[] };
}

export async function dbQuery(
  env: AkentrosRuntimeEnv,
  sql: string,
  params: unknown[] = [],
): Promise<QueryResult> {
  const tx = txStorage.getStore();
  if (tx) {
    // 交易內:綁定同一 client,保證語句落在同一交易。
    return executeQuery(tx.client, sql, params);
  }
  return executeQuery(poolFor(env), sql, params);
}

export async function withAkentrosTransaction<T>(env: AkentrosRuntimeEnv, fn: () => Promise<T>): Promise<T> {
  if (txStorage.getStore()) {
    // 巢狀呼叫:沿用外層交易。
    return fn();
  }
  const client = await poolFor(env).connect();
  try {
    await client.query("BEGIN");
    try {
      const result = await txStorage.run({ client }, fn);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {
        // 連線已失效時 release 即可,錯誤以原貌拋出。
      });
      throw error;
    }
  } finally {
    client.release();
  }
}

export async function dbGet(
  env: AkentrosRuntimeEnv,
  sql: string,
  params: unknown[] = [],
): Promise<any | null> {
  const { rows } = await dbQuery(env, sql, params);
  return rows[0] ?? null;
}

export function createAkentrosQuery(env: AkentrosRuntimeEnv): AkentrosQuery {
  const query = ((sql: string, params: unknown[] = []) => dbQuery(env, sql, params)) as AkentrosQuery;
  query.dialect = "postgres";
  query.transaction = (fn: () => Promise<unknown>) => withAkentrosTransaction(env, fn);
  return query;
}

// scripts 結束時釋放連線池(與 db.node.ts 的 closePostgresClients 對齊)。
export async function closePostgresClients(): Promise<void> {
  for (const pool of pools.values()) {
    try {
      await pool.end();
    } catch {
      // 已關閉的 pool 忽略。
    }
  }
  pools.clear();
}
