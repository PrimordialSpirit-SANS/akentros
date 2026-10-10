import pg from "pg";
import type { AkentrosRuntimeEnv } from "../types.ts";
import { type AkentrosPgLikePool, createAkentrosPgAdapter, pgPoolOptions } from "./db.pg.shared.ts";

// Node 部署的 PostgreSQL adapter(TCP pg Pool):以 pg Pool 實作
// (sql, params) => { rows } 查詢介面,契約與 db.node.ts 相同。由 db.ts 的
// installNodeAkentrosDbAdapter() 在 DATABASE_URL 為 postgres(ql):// 且
// 驅動選擇為 pg-pool 時動態載入(非字面量 specifier,Workers 打包不會把
// 本檔連同 pg 拉進 DO-SQLite 部署的執行路徑;Workers 的 PG 模式改經
// db.runtime.ts 以字面量動態 import 載入)。
//
// 適用環境:Node.js VPS、Render(常駐服務)、Vercel/Netlify 的 Node
// 函式(無伺服器預設 max=1,見 db.pg.shared.ts)、Cloudflare Workers
// 搭配 Hyperdrive 綁定(nodejs_compat 下 pg 走 Hyperdrive 的本地通道)。
//
// 慣例與交易語意見 db.pg.shared.ts;時間戳、布林、JSON 的儲存格式與
// SQLite adapter 完全一致。

// 連線字串解析:Workers 的 HYPERDRIVE 綁定優先(binding 的本地通道),
// 其餘環境一律 DATABASE_URL。若兩者皆無,查詢時以明確錯誤拒絕。
export function pgTcpConnectionString(env: AkentrosRuntimeEnv): string {
  const hyperdrive = env?.HYPERDRIVE as { connectionString?: unknown } | undefined;
  const fromBinding = typeof hyperdrive?.connectionString === "string" ? hyperdrive.connectionString : "";
  const url =
    fromBinding ||
    String(
      env?.DATABASE_URL || (typeof process !== "undefined" ? process.env.DATABASE_URL : "") || "",
    ).trim();
  return url;
}

function isViaHyperdrive(env: AkentrosRuntimeEnv): boolean {
  const hyperdrive = env?.HYPERDRIVE as { connectionString?: unknown } | undefined;
  return Boolean(typeof hyperdrive?.connectionString === "string" && hyperdrive.connectionString);
}

// globalThis 快取:Vercel/Netlify 開發模式與熱重載會重複載入模組,
// 模組級 Map 會在每次重載時重建、舊池的連線卻未釋放,連線數隨部署次數
// 累積;掛在 globalThis 讓同一實例內的所有模組版本共用同一批池。
const globalCache = globalThis as typeof globalThis & {
  __akentrosPgPools?: Map<string, AkentrosPgLikePool>;
};
globalCache.__akentrosPgPools ??= new Map<string, AkentrosPgLikePool>();

const adapter = createAkentrosPgAdapter({
  pools: globalCache.__akentrosPgPools,
  createPool(connectionString, env) {
    // SSL / 池上限判定需要同時看得到 Node 的 process.env 與 Workers 的
    // bindings env(前者涵蓋 Node 進入點,後者涵蓋 wrangler vars/secrets)。
    const merged = {
      ...(typeof process !== "undefined" ? process.env : {}),
      ...Object(env),
    } as Record<string, unknown>;
    const options = pgPoolOptions(connectionString, {
      env: merged,
      viaHyperdrive: isViaHyperdrive(env),
    });
    return new pg.Pool({
      connectionString,
      max: options.max,
      ssl: options.ssl,
      connectionTimeoutMillis: options.connectionTimeoutMillis,
    }) as unknown as AkentrosPgLikePool;
  },
  resolveConnectionString: pgTcpConnectionString,
});

export const dbQuery = adapter.dbQuery;
export const dbGet = adapter.dbGet;
export const withAkentrosTransaction = adapter.withAkentrosTransaction;
export const createAkentrosQuery = adapter.createAkentrosQuery;
// scripts 結束時釋放連線池(與 db.node.ts 的 closePostgresClients 對齊)。
export const closePostgresClients = adapter.closePostgresClients;

export { postgresPlaceholders } from "./db.pg.shared.ts";
