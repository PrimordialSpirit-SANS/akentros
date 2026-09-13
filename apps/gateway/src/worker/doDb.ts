import { AsyncLocalStorage } from "node:async_hooks";

// Cloudflare Durable Object 的 SQLite adapter:以 ctx.storage.sql 實作
// (sql, params) => { rows } 查詢介面,契約與 db.node.ts 相同。
//
// 部署模型:整個 Hono app 跑在單一 Durable Object instance 內(Worker 只做
// 轉發),所以:
// - 單寫者語義與 Node 自架部署一致:金鑰 RPM/併發、IP 限流、in-flight lease
//   都依賴「單一資料庫 + 程序內序列化」,DO 的事件模型天然滿足。
// - storage.sql 不支援交易控制語句(BEGIN/SAVEPOINT 等);多語句原子性改用
//   ctx.storage.transaction()(SQLite-backed DO 的 sql.exec 會被納入該
//   交易,拋錯即整體 rollback),交易期間其他事件的查詢排隊,
//   合計等價於 Node adapter 的獨佔寫入交易 + 其他查詢排隊等 COMMIT。
// - 列預設以欄名為 key 的物件回傳(同 node:sqlite 的 .all())。
// - 不需要 WAL/busy_timeout PRAGMA(workerd 自管 journaling)。

export interface BeaconDoSqlCursor {
  toArray(): any[];
}

export interface BeaconDoSql {
  exec(query: string, ...params: unknown[]): BeaconDoSqlCursor;
}

export interface BeaconDoState {
  storage: {
    sql: BeaconDoSql;
    transaction<T>(fn: () => Promise<T>): Promise<T>;
  };
}

type QueryResult = { rows: any[] };

function normalizeParam(value: any): string | number | null {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (Array.isArray(value)) return JSON.stringify(value);
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  // workerd 的 SQL 繫結只接受 number/string/ArrayBuffer/null,不接受 BigInt
  // (與 node:sqlite 不同);整數以 number 綁定,INTEGER-affinity 欄位仍會
  // 收斂為整數儲存,微美元等整數欄位語義不變。
  return value;
}

export function createDoBeaconDbAdapter(state: BeaconDoState) {
  const sql = state.storage.sql;

  const txStorage = new AsyncLocalStorage<{ depth: number }>();
  let txOpen = false;
  let txChain: Promise<unknown> = Promise.resolve();
  let pending: Array<() => void> = [];

  function flushPending() {
    const queue = pending;
    pending = [];
    while (queue.length) {
      queue.shift()?.();
    }
  }

  function executeQuery(query: string, params: any[]): QueryResult {
    const cursor = sql.exec(query, ...params.map(normalizeParam));
    return { rows: cursor.toArray() };
  }

  async function dbQuery(env: any, query: string, params: any[] = []): Promise<QueryResult> {
    void env;
    if (txStorage.getStore()) {
      // 交易內:直接同步執行,與 Node adapter 的交易內直連一致。
      return executeQuery(query, params);
    }
    if (txOpen) {
      // 其他事件在交易進行中發出的查詢:排隊,等交易結束再執行。
      return new Promise((resolve, reject) => {
        pending.push(() => {
          try {
            resolve(executeQuery(query, params));
          } catch (error) {
            reject(error);
          }
        });
      });
    }
    return executeQuery(query, params);
  }

  // 交易封裝:storage.transaction 提供原子性(fn 拋錯即整體 rollback),
  // txOpen 讓其他事件在交易期間發出的查詢排隊等交易結束 —— 合計等價
  // Node adapter 的獨佔寫入交易。刻意不用 blockConcurrencyWhile:它會
  // 延遲事件交付,fn 一旦 await runtime I/O 即死鎖(交易 fn 依契約不會,
  // 但不作假設較安全)。以 promise chain 串行化,對齊 SQLite 單寫者語義。
  function withBeaconTransaction<T>(env: any, fn: () => Promise<T>): Promise<T> {
    void env;
    if (txStorage.getStore()) {
      // 巢狀呼叫:沿用外層交易。
      return fn();
    }
    const run = txChain.then(async () => {
      txOpen = true;
      try {
        return await state.storage.transaction(() => txStorage.run({ depth: 1 }, fn));
      } finally {
        txOpen = false;
        flushPending();
      }
    });
    txChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run as Promise<T>;
  }

  async function dbGet(env: any, query: string, params: any[] = []): Promise<any | null> {
    const { rows } = await dbQuery(env, query, params);
    return rows[0] ?? null;
  }

  function createBeaconQuery(env: any) {
    const query = (statement: string, params: any[] = []) => dbQuery(env, statement, params);
    (query as any).transaction = (fn: () => Promise<any>) => withBeaconTransaction(env, fn);
    return query;
  }

  async function closePostgresClients(): Promise<void> {
    // DO 的連線生命週期由 runtime 管理;保留匯出以對齊 adapter 契約。
  }

  return { dbQuery, dbGet, withBeaconTransaction, createBeaconQuery, closePostgresClients };
}
