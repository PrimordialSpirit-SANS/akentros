import { AsyncLocalStorage } from "node:async_hooks";
import type { AkentrosQuery } from "@akentros/core/query";
import type { AkentrosRuntimeEnv } from "../types.ts";
import { logAkentrosEvent } from "./logger.ts";

// PostgreSQL adapter 的共用實作:TCP pg Pool(db.pg.ts)與 Neon 相容
// WebSocket 驅動(db.pg.serverless.ts)共用同一套查詢介面與交易語意,
// 契約與 db.node.ts / doDb.ts 相同:(sql, params) => { rows },交易以
// withAkentrosTransaction(env, fn) 包裝,fn 內不得有真實 I/O await。
//
// 本檔刻意不 import 任何資料庫驅動(pg、@neondatabase/serverless):
// 兩個 adapter 模組只被 Node 進入點 / Workers PG 模式以動態 import 載入,
// 共用邏輯集中在這裡,讓兩種驅動的行為差異只剩「連線怎麼建立」。
//
// 慣例(與 db.pg.ts 歷史行為一致):
// - 時間戳一律 TEXT 存 UTC ISO-8601 字串;布林以 1/0 整數;JSON 以 TEXT。
// - 佔位符:core 的 SQL 以 SQLite 風格「?」撰寫,此處轉換為「$n」。
// - 交易:專屬 client,BEGIN … COMMIT/ROLLBACK;交易內的查詢以
//   AsyncLocalStorage 綁定同一 client;巢狀呼叫沿用外層交易。

/** node-postgres 與 @neondatabase/serverless 共通的 client 形狀。 */
export interface AkentrosPgLikeClient {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
  release(): void;
}

/** node-postgres 與 @neondatabase/serverless 共通的 Pool 形狀。 */
export interface AkentrosPgLikePool {
  connect(): Promise<AkentrosPgLikeClient>;
  end(): Promise<void>;
  /** 交易外的查詢直接走 pool(排隊取用間置連線);兩個驅動都支援。 */
  query?(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
  on?(event: "error", listener: (error: unknown) => void): unknown;
}

export interface AkentrosPgAdapterConfig {
  /** 連線池快取(key 為連線字串)。呼叫端負責掛在 globalThis 上,讓
   * Vercel/Netlify 等無伺服器平台的熱重載 / 隔離重複載入不會重複建池。 */
  pools: Map<string, AkentrosPgLikePool>;
  /** 依連線字串與執行期環境建立底層 Pool(驅動特定;env 用於 SSL/池上限判定)。 */
  createPool: (connectionString: string, env: AkentrosRuntimeEnv) => AkentrosPgLikePool;
  /** 從執行期環境解析連線字串(HYPERDRIVE 綁定優先等邏輯由呼叫端決定)。 */
  resolveConnectionString: (env: AkentrosRuntimeEnv) => string;
}

// 佔位符轉換:SQLite 風格「?」→ PostgreSQL「$n」。
export function postgresPlaceholders(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

// 參數正規化:與 SQLite adapter 慣例對齊(布林 1/0、JSON 字串化、
// bigint 以文字傳遞——PG 不接受 BigInt 綁定)。
export function normalizePgParam(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return JSON.stringify(value);
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return value;
}

// ---------------------------------------------------------------------------
// SSL 推導:無伺服器平台(Neon、Supabase、Render 外網、RDS…)一律要求
// TLS;自架 PG(localhost / 內網 / unix socket)則不應被強制加密。
// 解析優先序:AKENTROS_PG_SSL 環境變數 > 連線字串 sslmode/ssl 參數 >
// 主機啟發式(遠端主機自動 require)。Hyperdrive 由邊緣終結 TLS,本機
// socket 不加密。
// ---------------------------------------------------------------------------

export type AkentrosPgSslOption = false | { rejectUnauthorized: boolean };

function sslFromMode(mode: string): AkentrosPgSslOption | null {
  const normalized = mode.trim().toLowerCase();
  if (!normalized) return null;
  switch (normalized) {
    case "disable":
    case "allow":
      return false;
    case "prefer":
    case "require":
      return { rejectUnauthorized: false };
    case "verify-ca":
    case "verify-full":
      return { rejectUnauthorized: true };
    default:
      return null;
  }
}

/** 內網 / 本機主機不強制 TLS(可用 AKENTROS_PG_SSL=require 覆寫)。 */
export function isPrivatePgHost(host: string): boolean {
  if (!host) return true; // 無 host = unix socket
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1") return true;
  if (h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^(fc|fd|fe80)/.test(h)) return true; // IPv6 ULA / link-local
  return false;
}

export function resolvePgSslOptions(
  connectionString: string,
  options?: { env?: Pick<AkentrosRuntimeEnv, "AKENTROS_PG_SSL">; viaHyperdrive?: boolean },
): AkentrosPgSslOption {
  if (options?.viaHyperdrive) {
    // Hyperdrive binding 的 connectionString 指向 runtime 內的本地通道,
    // 對外連線的 TLS 由 Hyperdrive 代管;client 端再開 TLS 會交涉失敗。
    return false;
  }

  // 顯式環境變數優先:部署層的總開關。
  const fromEnv = sslFromMode(String(options?.env?.AKENTROS_PG_SSL || ""));
  if (fromEnv !== null) return fromEnv;

  // 連線字串參數:URL 形式或 pg keyword/value 形式都支援。
  let urlSsl: string | null = null;
  try {
    const parsed = new URL(connectionString);
    urlSsl = parsed.searchParams.get("sslmode") ?? parsed.searchParams.get("ssl");
  } catch {
    const keyword = /(?:^|\s)sslmode\s*=\s*'?([\w-]+)'?/.exec(connectionString);
    const sslFlag = /(?:^|\s)ssl\s*=\s*(true|false)/i.exec(connectionString);
    urlSsl = keyword?.[1] ?? sslFlag?.[1] ?? null;
  }
  if (urlSsl === "true") return { rejectUnauthorized: false };
  if (urlSsl === "false") return false;
  if (urlSsl) {
    const fromUrl = sslFromMode(urlSsl);
    if (fromUrl !== null) return fromUrl;
  }

  // 啟發式:遠端主機(受管 PG)自動 require;本機 / 內網維持明文。
  let host = "";
  try {
    host = new URL(connectionString).hostname;
  } catch {
    const hostMatch = /(?:^|\s)host\s*=\s*(\S+)/.exec(connectionString);
    host = hostMatch?.[1] ?? "";
  }
  if (isPrivatePgHost(host)) return false;
  return { rejectUnauthorized: false };
}

// ---------------------------------------------------------------------------
// 連線池尺寸:無伺服器函式環境每個實例一條連線,避免併發實例 × 池上限
// 打爆受管 PG 的連線數(Neon 免費版 100 條上下)。
// ---------------------------------------------------------------------------

export function isServerlessComputeEnv(env?: Record<string, unknown>): boolean {
  // Cloudflare Workers / Pages Functions(process.env 多半為空,改探 UA)。
  const userAgent =
    typeof navigator !== "undefined" ? String((navigator as { userAgent?: string }).userAgent || "") : "";
  if (userAgent.includes("Cloudflare-Workers")) return true;
  const e = (typeof process !== "undefined" ? process.env : {}) as Record<string, unknown>;
  return Boolean(
    e.VERCEL || e.NETLIFY || e.AWS_LAMBDA_FUNCTION_NAME || e.CF_PAGES || env?.VERCEL || env?.NETLIFY,
  );
}

export function defaultPgPoolMax(env?: Record<string, unknown>): number {
  const raw = Number(
    env?.AKENTROS_PG_POOL_MAX ??
      (typeof process !== "undefined" ? process.env.AKENTROS_PG_POOL_MAX : undefined),
  );
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return isServerlessComputeEnv(env) ? 1 : 10;
}

/** pg Pool 的共通選項(SSL、池上限、連線逾時)。 */
export function pgPoolOptions(
  connectionString: string,
  options?: { env?: Record<string, unknown>; viaHyperdrive?: boolean },
): { max: number; ssl: AkentrosPgSslOption; connectionTimeoutMillis: number } {
  return {
    max: defaultPgPoolMax(options?.env),
    ssl: resolvePgSslOptions(connectionString, {
      env: options?.env as Pick<AkentrosRuntimeEnv, "AKENTROS_PG_SSL">,
      viaHyperdrive: options?.viaHyperdrive,
    }),
    // 健康的 PG 握手 < 1s;無伺服器冷啟時卡死連線會吃掉整個請求預算,
    // 10s 上限讓失敗及早暴露(逾時即錯誤,由上游重試)。
    connectionTimeoutMillis: 10_000,
  };
}

// ---------------------------------------------------------------------------
// Adapter 工廠:兩種驅動共用(交易語意釘死在測試裡,見 pgServerless.test.ts)。
// ---------------------------------------------------------------------------

export function createAkentrosPgAdapter(config: AkentrosPgAdapterConfig): {
  dbQuery: (env: AkentrosRuntimeEnv, sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
  dbGet: (env: AkentrosRuntimeEnv, sql: string, params?: unknown[]) => Promise<any | null>;
  withAkentrosTransaction: <T>(env: AkentrosRuntimeEnv, fn: () => Promise<T>) => Promise<T>;
  createAkentrosQuery: (env: AkentrosRuntimeEnv) => AkentrosQuery;
  closePostgresClients: () => Promise<void>;
} {
  const pools = config.pools;
  const txStorage = new AsyncLocalStorage<{ client: AkentrosPgLikeClient }>();

  function poolFor(env: AkentrosRuntimeEnv): AkentrosPgLikePool {
    const connectionString = String(config.resolveConnectionString(env) || "").trim();
    if (!connectionString) {
      throw new Error(
        "PostgreSQL adapter requires a connection string: set DATABASE_URL " +
          "(or a HYPERDRIVE binding on Cloudflare Workers).",
      );
    }
    let pool = pools.get(connectionString);
    if (!pool) {
      pool = config.createPool(connectionString, env);
      // 連線池背景錯誤(idle client 斷線、供應商重啟、Neon suspend)不得
      // 變成未處理的 'error' 事件把程序/隔離區炸掉;記錄後由池自行重連。
      if (typeof pool.on === "function") {
        pool.on("error", (error) => {
          logAkentrosEvent("warn", "akentros_pg_pool_client_error", {
            detail: String((error as { message?: string })?.message || error),
          });
        });
      }
      pools.set(connectionString, pool);
    }
    return pool;
  }

  async function executeQuery(
    client: AkentrosPgLikeClient | AkentrosPgLikePool,
    sql: string,
    params: unknown[],
  ): Promise<{ rows: any[] }> {
    // 交易外:優先以 pool.query(排隊取用間置連線);交易內:ALS 綁定的
    // 專屬 client。兩者的方法都以 .call 綁定原物件呼叫,避免 detach 後
    // 遺失 this。
    const queryFn = (client as AkentrosPgLikePool).query ?? (client as AkentrosPgLikeClient).query;
    if (typeof queryFn !== "function") {
      throw new Error("The PostgreSQL pool/client does not expose query(text, params).");
    }
    const result = await queryFn.call(client, postgresPlaceholders(sql), params.map(normalizePgParam));
    return { rows: result.rows as any[] };
  }

  async function dbQuery(
    env: AkentrosRuntimeEnv,
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: any[] }> {
    const tx = txStorage.getStore();
    if (tx) {
      // 交易內:綁定同一 client,保證語句落在同一交易。
      return executeQuery(tx.client, sql, params);
    }
    return executeQuery(poolFor(env), sql, params);
  }

  async function withAkentrosTransaction<T>(env: AkentrosRuntimeEnv, fn: () => Promise<T>): Promise<T> {
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

  async function dbGet(env: AkentrosRuntimeEnv, sql: string, params: unknown[] = []): Promise<any | null> {
    const { rows } = await dbQuery(env, sql, params);
    return rows[0] ?? null;
  }

  function createAkentrosQuery(env: AkentrosRuntimeEnv): AkentrosQuery {
    const query = ((sql: string, params: unknown[] = []) => dbQuery(env, sql, params)) as AkentrosQuery;
    query.dialect = "postgres";
    query.transaction = (fn: () => Promise<unknown>) => withAkentrosTransaction(env, fn);
    return query;
  }

  async function closePostgresClients(): Promise<void> {
    for (const pool of pools.values()) {
      try {
        await pool.end();
      } catch {
        // 已關閉的 pool 忽略。
      }
    }
    pools.clear();
  }

  return { dbQuery, dbGet, withAkentrosTransaction, createAkentrosQuery, closePostgresClients };
}
