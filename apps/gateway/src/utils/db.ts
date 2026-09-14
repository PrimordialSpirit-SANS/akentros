import type { BeaconRuntimeEnv } from "../types.ts";
// DB adapter 註冊點:gateway 其餘程式只依賴這個模組的查詢介面,實作可替換:
// - Node 自架部署:進入點(nodeServer、migrate/reconcile scripts)啟動時呼叫
//   installNodeBeaconDbAdapter(),動態載入本目錄的 db.node.ts(node:sqlite)。
// - Cloudflare Workers 部署:Durable Object 建構子呼叫 installBeaconDbAdapter(),
//   安裝 src/worker/doDb.ts(ctx.storage.sql)。
// 兩種 adapter 契約相同:(sql, params) => { rows },交易以
// withBeaconTransaction(env, fn) 包裝,fn 內不得有真實 I/O await
// (provider 呼叫一律在交易外)。

export interface BeaconDbQueryResult {
  rows: any[];
}

export type BeaconDbAdapter = {
  dbQuery: (env: BeaconRuntimeEnv, sql: string, params?: any[]) => Promise<BeaconDbQueryResult>;
  dbGet: (env: BeaconRuntimeEnv, sql: string, params?: any[]) => Promise<any | null>;
  withBeaconTransaction: (env: BeaconRuntimeEnv, fn: () => Promise<any>) => Promise<any>;
  createBeaconQuery: (env: BeaconRuntimeEnv) => any;
  closePostgresClients: () => Promise<void>;
};

let installedAdapter: BeaconDbAdapter | null = null;

export function installBeaconDbAdapter(adapter: BeaconDbAdapter) {
  installedAdapter = adapter;
}

// Node 進入點啟動時呼叫一次。specifier 刻意以非字面量的形式動態 import:
// 讓 Workers 打包(esbuild)無法靜態解析、不會把 node:sqlite 拉進 bundle;
// Node 執行期仍以相對於本檔的 URL 正常解析。
export async function installNodeBeaconDbAdapter() {
  if (installedAdapter) return;
  const specifier = ["./db", "node", "ts"].join(".");
  installedAdapter = (await import(specifier)) as BeaconDbAdapter;
}

function requireAdapter(): BeaconDbAdapter {
  if (installedAdapter) return installedAdapter;
  throw new Error(
    "Beacon DB adapter is not installed: Node entries must call installNodeBeaconDbAdapter() " +
      "at startup; on Cloudflare Workers the request must run inside the BEACON_DO Durable Object.",
  );
}

export function dbQuery(
  env: BeaconRuntimeEnv,
  sql: string,
  params: any[] = [],
): Promise<BeaconDbQueryResult> {
  return requireAdapter().dbQuery(env, sql, params);
}

export function dbGet(env: BeaconRuntimeEnv, sql: string, params: any[] = []): Promise<any | null> {
  return requireAdapter().dbGet(env, sql, params);
}

export function withBeaconTransaction<T>(env: BeaconRuntimeEnv, fn: () => Promise<T>): Promise<T> {
  return requireAdapter().withBeaconTransaction(env, fn) as Promise<T>;
}

export function createBeaconQuery(env: BeaconRuntimeEnv) {
  return requireAdapter().createBeaconQuery(env);
}

export function closePostgresClients(): Promise<void> {
  return requireAdapter().closePostgresClients();
}
