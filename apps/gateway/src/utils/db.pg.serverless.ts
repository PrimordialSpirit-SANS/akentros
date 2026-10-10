import { Pool as NeonServerlessPool, neonConfig } from "@neondatabase/serverless";
import type { AkentrosRuntimeEnv } from "../types.ts";
import { type AkentrosPgLikePool, createAkentrosPgAdapter, defaultPgPoolMax } from "./db.pg.shared.ts";

// 無伺服器 PostgreSQL adapter(Neon 相容 WebSocket 驅動):以
// @neondatabase/serverless 的 Pool 實作 (sql, params) => { rows },契約與
// db.pg.ts 完全相同——這是關鍵設計:Neon 驅動的 WebSocket 模式是「真正的
// 互動式 PG 連線」,BEGIN/COMMIT、SELECT … FOR UPDATE、pg_advisory_xact_lock
// 全部逐語句往返執行,core 金錢路徑(預留→讀值判定→結算/退款)的互動式
// 交易語意原封不動。純 HTTP 批次模式無法支撐「讀後才決定下一步」的交易,
// 刻意不提供——計費不變式優先於每請求延遲。
//
// 適用環境(凡是有全域 WebSocket 的 runtime 皆可):
// - Neon Postgres(任何平台:Vercel/Netlify 函式與 Edge、Cloudflare
//   Workers、Deno、Node ≥ 22 內建 WebSocket)。建議連 Neon 的 pooled
//   endpoint(-pooler 主機名)降低每實例連線建立成本。
// - 任何相容 pg-gateway / supavisor WebSocket 閘道的 PG:設
//   AKENTROS_PG_WS_PROXY 指向閘道(如 "pooler.example.com:5432/v1"),
//   閘道主機字串含 "{host}" 時視為模板。
//
// 選擇此驅動的方式(見 db.ts 的 selectAkentrosPgDriver):
//   1. AKENTROS_PG_DRIVER=neon 明確指定;
//   2. AKENTROS_PG_WS_PROXY 已設定(自架 WS 閘道);
//   3. DATABASE_URL 主機為 *.neon.tech(自動)。
// Workers 的 DO-SQLite 部署不會載入本檔;Workers 的 PG 模式經 db.runtime.ts
// 以字面量動態 import 載入(esbuild 會切成獨立 chunk,不用就不載入)。

/** 解析 AKENTROS_PG_WS_PROXY:靜態主機(可含 port/path)或 {host} 模板。 */
export function resolveWsProxySetting(
  raw: string,
): string | ((host: string, port: number | string) => string) | null {
  const value = String(raw || "").trim();
  if (!value) return null;
  if (value.includes("{host}")) {
    return (host: string, port: number | string) =>
      value.replace(/\{host\}/g, host).replace(/\{port\}/g, String(port));
  }
  return value;
}

let neonConfigured = false;

// neonConfig 是驅動的全域狀態;以第一次建池時的環境設定一次。不同請求
// 帶不同 WS proxy 設定的場景不存在(單一部署 = 單一設定),若真發生,
// 以第一個為準並留下警告。
function configureNeonDriverOnce(env: AkentrosRuntimeEnv): void {
  if (neonConfigured) return;
  neonConfigured = true;

  const webSocketConstructor = (globalThis as { WebSocket?: unknown }).WebSocket;
  if (typeof webSocketConstructor !== "function") {
    throw new Error(
      "The serverless PostgreSQL driver requires a global WebSocket constructor " +
        "(Node >= 22, Cloudflare Workers, Vercel/Netlify Edge all provide one). " +
        "On older Node runtimes use AKENTROS_PG_DRIVER=pg-pool instead.",
    );
  }
  neonConfig.webSocketConstructor = webSocketConstructor as typeof neonConfig.webSocketConstructor;

  const proxy = resolveWsProxySetting(String(env?.AKENTROS_PG_WS_PROXY || ""));
  if (proxy) {
    neonConfig.wsProxy = proxy;
  }

  // wss(加密)為預設;僅自架 WS 閘道於 TLS 終結之後時才需要
  // AKENTROS_PG_WS_SECURE=false(本地開發的 pg-gateway 等)。
  const secure = String(env?.AKENTROS_PG_WS_SECURE ?? "true")
    .trim()
    .toLowerCase();
  neonConfig.useSecureWebSocket = secure !== "false";
}

// 連線字串:此驅動不經 Hyperdrive(Hyperdrive 是給 TCP pg 驅動用的),
// 一律 DATABASE_URL(Node 的 process.env 為後備)。
export function neonConnectionString(env: AkentrosRuntimeEnv): string {
  return String(
    env?.DATABASE_URL || (typeof process !== "undefined" ? process.env.DATABASE_URL : "") || "",
  ).trim();
}

// globalThis 快取(理由同 db.pg.ts:熱重載/隔離重複載入不得重複建池)。
const globalCache = globalThis as typeof globalThis & {
  __akentrosNeonPools?: Map<string, AkentrosPgLikePool>;
};
globalCache.__akentrosNeonPools ??= new Map<string, AkentrosPgLikePool>();

const adapter = createAkentrosPgAdapter({
  pools: globalCache.__akentrosNeonPools,
  createPool(connectionString, env) {
    configureNeonDriverOnce(env);
    const merged = {
      ...(typeof process !== "undefined" ? process.env : {}),
      ...Object(env),
    } as Record<string, unknown>;
    return new NeonServerlessPool({
      connectionString,
      max: defaultPgPoolMax(merged),
      connectionTimeoutMillis: 10_000,
    }) as unknown as AkentrosPgLikePool;
  },
  resolveConnectionString: neonConnectionString,
});

export const dbQuery = adapter.dbQuery;
export const dbGet = adapter.dbGet;
export const withAkentrosTransaction = adapter.withAkentrosTransaction;
export const createAkentrosQuery = adapter.createAkentrosQuery;
export const closePostgresClients = adapter.closePostgresClients;
