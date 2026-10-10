import type { AkentrosQuery } from "@akentros/core/query";
import type { AkentrosRuntimeEnv } from "../types.ts";
// DB adapter 註冊點:gateway 其餘程式只依賴這個模組的查詢介面,實作可替換:
// - Node 進入點(nodeServer、migrate/reconcile scripts)啟動時呼叫
//   installNodeAkentrosDbAdapter(),依 DATABASE_URL / AKENTROS_PG_DRIVER
//   動態載入本目錄的 db.node.ts(node:sqlite)、db.pg.ts(TCP pg Pool)
//   或 db.pg.serverless.ts(Neon 相容 WebSocket 無伺服器驅動)。
// - Cloudflare Workers:預設 DO-SQLite 拓撲由 Durable Object 建構子安裝
//   src/worker/doDb.ts;PG 模式(DATABASE_URL 或 HYPERDRIVE 綁定)由
//   src/worker/pgRuntime.ts 經 db.runtime.ts 載入 PG adapter。
// 所有 adapter 契約相同:(sql, params) => { rows },交易以
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

// Node 部署的運行方言:DATABASE_URL 為 postgres(ql):// 時使用 PostgreSQL
// adapter,其餘(含預設 AKENTROS_DB_PATH)走 node:sqlite。Workers 的
// DO-SQLite 拓撲不經此函式。
export function isPostgresDatabaseUrl(value: unknown): boolean {
  return /^postgres(ql)?:\/\//i.test(String(value || "").trim());
}

export function runtimeDialect(env: AkentrosRuntimeEnv): "postgres" | "sqlite" {
  return isPostgresDatabaseUrl(env?.DATABASE_URL) ? "postgres" : "sqlite";
}

// ---------------------------------------------------------------------------
// PostgreSQL 驅動選擇:TCP pg Pool(VPS / Render / Vercel-Netlify Node 函式 /
// Workers+Hyperdrive)vs Neon 相容 WebSocket 無伺服器驅動(邊緣 runtime、
// Neon、自架 WS 閘道)。規則:
//   1. AKENTROS_PG_DRIVER 明確指定(別名見下),無效值 fail-fast;
//   2. HYPERDRIVE 綁定存在 → pg-pool(binding 的本地通道即為 TCP pg);
//   3. AKENTROS_PG_WS_PROXY 已設定(自架 pg-gateway/supavisor)→ neon;
//   4. DATABASE_URL 主機為 *.neon.tech → neon;
//   5. 其餘 → pg-pool。
// ---------------------------------------------------------------------------

export type AkentrosPgDriver = "pg-pool" | "neon";

const PG_POOL_DRIVER_ALIASES = new Set(["pg-pool", "pg", "node", "tcp"]);
const NEON_DRIVER_ALIASES = new Set(["neon", "neon-ws", "serverless", "ws"]);

function pgUrlHost(connectionString: string): string {
  try {
    return new URL(connectionString).hostname.toLowerCase();
  } catch {
    const keyword = /(?:^|\s)host\s*=\s*(\S+)/.exec(connectionString);
    return (keyword?.[1] ?? "").toLowerCase();
  }
}

function hasHyperdriveBinding(env: AkentrosRuntimeEnv | undefined): boolean {
  const binding = env?.HYPERDRIVE as { connectionString?: unknown } | undefined;
  return typeof binding?.connectionString === "string" && binding.connectionString.length > 0;
}

export function selectAkentrosPgDriver(env?: AkentrosRuntimeEnv): AkentrosPgDriver {
  const explicit = String(env?.AKENTROS_PG_DRIVER || "")
    .trim()
    .toLowerCase();
  if (explicit) {
    if (PG_POOL_DRIVER_ALIASES.has(explicit)) return "pg-pool";
    if (NEON_DRIVER_ALIASES.has(explicit)) return "neon";
    throw new Error(`AKENTROS_PG_DRIVER "${explicit}" is not recognized: expected auto | pg-pool | neon.`);
  }
  if (hasHyperdriveBinding(env)) return "pg-pool";
  const url = String(env?.DATABASE_URL || "").trim();
  if (String(env?.AKENTROS_PG_WS_PROXY || "").trim()) return "neon";
  if (/(^|\.)neon\.tech$/i.test(pgUrlHost(url))) return "neon";
  return "pg-pool";
}

// Workers 進入點的 PG 模式判定:DATABASE_URL 為 postgres:// 或設有
// HYPERDRIVE 綁定時,流量不再進 Durable Object,改由 worker/pgRuntime.ts
// 直接跑 Hono app + PG adapter(見 src/worker.ts)。
export function isWorkerPgRuntime(env?: AkentrosRuntimeEnv): boolean {
  return isPostgresDatabaseUrl(env?.DATABASE_URL) || hasHyperdriveBinding(env);
}

// Node 進入點啟動時呼叫一次(依 DATABASE_URL 與驅動選擇 adapter)。
// specifier 刻意以非字面量的形式動態 import:讓 Workers 打包(esbuild)
// 無法靜態解析、不會把 node:sqlite / pg / @neondatabase/serverless 拉進
// bundle;Node 執行期仍以相對於本檔的 URL 正常解析。Workers 的 PG 模式
// 改用 db.runtime.ts 的字面量動態 import(esbuild 會切成獨立 chunk)。
export async function installNodeAkentrosDbAdapter() {
  if (installedAdapter) return;
  if (isPostgresDatabaseUrl(process.env?.DATABASE_URL)) {
    const driver = selectAkentrosPgDriver(process.env as AkentrosRuntimeEnv);
    const specifier =
      driver === "neon" ? ["./db", "pg", "serverless", "ts"].join(".") : ["./db", "pg", "ts"].join(".");
    installedAdapter = (await import(specifier)) as AkentrosDbAdapter;
    return;
  }
  installedAdapter = (await import(["./db", "node", "ts"].join("."))) as AkentrosDbAdapter;
}

function requireAdapter(): AkentrosDbAdapter {
  if (installedAdapter) return installedAdapter;
  throw new Error(
    "Akentros DB adapter is not installed: Node entries must call installNodeAkentrosDbAdapter() " +
      "at startup; on Cloudflare Workers the request must run inside the AKENTROS_DO Durable Object " +
      "(SQLite topology) or through the PG runtime (worker/pgRuntime.ts).",
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
