import type { AkentrosQuery } from "@akentros/core/query";
import type { AkentrosRuntimeEnv } from "../types.ts";
// DB adapter 註冊點:gateway 其餘程式只依賴這個模組的查詢介面,實作可替換:
// - Node 自架部署:進入點(nodeServer、migrate/reconcile scripts)啟動時呼叫
//   installNodeAkentrosDbAdapter(),動態載入本目錄的 db.node.ts(node:sqlite)。
// - Cloudflare Workers 部署:Durable Object 建構子呼叫 installAkentrosDbAdapter(),
//   安裝 src/worker/doDb.ts(ctx.storage.sql)。
// 兩種 adapter 契約相同:(sql, params) => { rows },交易以
// withAkentrosTransaction(env, fn) 包裝,fn 內不得有真實 I/O await
// (provider 呼叫一律在交易外)。

export interface AkentrosDbQueryResult {
  rows: any[];
}

export type AkentrosDbAdapter = {
  dbQuery: (env: AkentrosRuntimeEnv, sql: string, params?: any[]) => Promise<AkentrosDbQueryResult>;
  dbGet: (env: AkentrosRuntimeEnv, sql: string, params?: any[]) => Promise<any | null>;
  withAkentrosTransaction: (env: AkentrosRuntimeEnv, fn: () => Promise<any>) => Promise<any>;
  createAkentrosQuery: (env: AkentrosRuntimeEnv) => AkentrosQuery;
  closePostgresClients: () => Promise<void>;
};

let installedAdapter: AkentrosDbAdapter | null = null;

export function installAkentrosDbAdapter(adapter: AkentrosDbAdapter) {
  installedAdapter = adapter;
}

// Node 自架部署的運行方言:DATABASE_URL 為 postgres(ql):// 時使用 PostgreSQL
// adapter,其餘(含預設 AKENTROS_DB_PATH)走 node:sqlite。Workers 部署固定
// SQLite(DO storage.sql),不經此函式。
export function isPostgresDatabaseUrl(value: unknown): boolean {
  return /^postgres(ql)?:\/\//i.test(String(value || "").trim());
}

export function runtimeDialect(env: AkentrosRuntimeEnv): "postgres" | "sqlite" {
  return isPostgresDatabaseUrl(env?.DATABASE_URL) ? "postgres" : "sqlite";
}

// Node 進入點啟動時呼叫一次(依 DATABASE_URL 選擇 adapter)。specifier 刻意
// 以非字面量的形式動態 import:讓 Workers 打包(esbuild)無法靜態解析、不會
// 把 node:sqlite 或 pg 拉進 bundle;Node 執行期仍以相對於本檔的 URL 正常解析。
export async function installNodeAkentrosDbAdapter() {
  if (installedAdapter) return;
  const specifier = isPostgresDatabaseUrl(process.env.DATABASE_URL)
    ? ["./db", "pg", "ts"].join(".")
    : ["./db", "node", "ts"].join(".");
  installedAdapter = (await import(specifier)) as AkentrosDbAdapter;
}

function requireAdapter(): AkentrosDbAdapter {
  if (installedAdapter) return installedAdapter;
  throw new Error(
    "Akentros DB adapter is not installed: Node entries must call installNodeAkentrosDbAdapter() " +
      "at startup; on Cloudflare Workers the request must run inside the AKENTROS_DO Durable Object.",
  );
}

export function dbQuery(
  env: AkentrosRuntimeEnv,
  sql: string,
  params: any[] = [],
): Promise<AkentrosDbQueryResult> {
  return requireAdapter().dbQuery(env, sql, params);
}

export function dbGet(env: AkentrosRuntimeEnv, sql: string, params: any[] = []): Promise<any | null> {
  return requireAdapter().dbGet(env, sql, params);
}

export function withAkentrosTransaction<T>(env: AkentrosRuntimeEnv, fn: () => Promise<T>): Promise<T> {
  return requireAdapter().withAkentrosTransaction(env, fn) as Promise<T>;
}

export function createAkentrosQuery(env: AkentrosRuntimeEnv): AkentrosQuery {
  return requireAdapter().createAkentrosQuery(env);
}

export function closePostgresClients(): Promise<void> {
  return requireAdapter().closePostgresClients();
}
