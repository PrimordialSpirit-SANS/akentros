// 資料庫查詢介面契約:Node(node:sqlite)與 Cloudflare Workers(Durable
// Object storage.sql)兩種 adapter,以及測試的替身 query,都符合這個形狀。
// core 的 store 只依賴本契約,不依賴任何 runtime 的資料庫型別;gateway 端
// 的 db adapter(db.ts / db.node.ts / doDb.ts)負責提供符合契約的實作。

export interface BeaconQueryResult {
  rows?: unknown[];
}

export type BeaconQueryFn = (sql: string, params?: unknown[]) => Promise<BeaconQueryResult>;

// 可選交易能力:SQLite adapter 會提供 transaction(fn)(BEGIN IMMEDIATE…
// COMMIT,或 DO 的 ctx.storage.transaction);沒有提供時(部分測試替身)
// store 退回逐語句執行,由呼叫端保證語義。
export type BeaconQuery = BeaconQueryFn & {
  transaction?: (fn: () => Promise<unknown>) => Promise<unknown>;
};

// 各 store 內部共用的列取樣器。回傳 any[] 是刻意的:SQL 列在「讀取當下」
// 仍是未定型資料,欄位驗證由各 store 的 normalize/requiredString 完成;
// 對外回傳值一律以明確介面呈現。
export function beaconQueryRows(result: BeaconQueryResult | null | undefined): any[] {
  return Array.isArray(result?.rows) ? result.rows : [];
}
