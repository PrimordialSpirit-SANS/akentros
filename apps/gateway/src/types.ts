import type { Context, Next } from "hono";
import type { AkentrosAccount } from "./utils/users.ts";

// Gateway 的執行期環境:Node 自架部署是 process.env,Workers 部署是 bindings。
// 已知變數逐一宣告;供應商金鑰(OPENROUTER_API_KEY_1 …)等其餘項目由索引
// 簽章涵蓋,讀取端就近以 String()/Number() 轉型,不假設任意欄位的型別。
export interface AkentrosRuntimeEnv {
  AKENTROS_ENABLED?: string;
  AKENTROS_DB_PATH?: string;
  AKENTROS_API_KEY_PEPPER?: string;
  AKENTROS_DISABLE_REGISTRATION?: string;
  AKENTROS_SIGNUP_BONUS_USD?: string;
  AKENTROS_ADMIN_STARTING_CREDITS_USD?: string;
  AKENTROS_PBKDF2_ITERATIONS?: string;
  AKENTROS_PUBLIC_ORIGINS?: string;
  AKENTROS_TRUST_PROXY?: string;
  ADMIN_EMAIL?: string;
  ADMIN_PASSWORD?: string;
  ADMIN_USERNAME?: string;
  DATABASE_URL?: string;
  JWT_SECRET?: string;
  FRONTEND_ORIGINS?: string;
  FRONTEND_BASE_URL?: string;
  PUBLIC_BASE_URL?: string;
  OAUTH_PUBLIC_BASE_URL?: string;
  ENVIRONMENT?: string;
  PORT?: string;
  AKENTROS_PORT?: string;
  AKENTROS_MAINTENANCE_INTERVAL_MS?: string;
  AKENTROS_RECONCILE_LIMIT?: string;
  [key: string]: unknown;
}

// 金鑰查驗(aiAuth)與開發者 session 憑證(ensureAkentrosSessionCredential)
// 放進 context 的共用形狀。session 憑證沒有 prefix/suffix,故為選配。
export interface AkentrosKeyUser {
  id: string;
  username: string;
  role: string;
  is_banned: boolean;
  is_flagged: boolean;
  restricted_services: unknown;
}

export interface AkentrosAuthenticatedKey {
  id: string;
  user_id: number | string;
  name: string;
  prefix?: string;
  suffix?: string;
  scopes: string[];
  model_allowlist: string[];
  rpm_limit: number;
  max_in_flight: number;
  spend_limit_usd_micros: number | null;
  spend_used_usd_micros: number;
  idempotency_replay_ttl_seconds: number;
  user: AkentrosKeyUser;
}

export interface AkentrosVariables {
  user?: AkentrosAccount;
  aiKey?: AkentrosAuthenticatedKey;
  aiUser?: AkentrosKeyUser;
  aiRequestId?: string;
}

export type AkentrosEnv = { Bindings: AkentrosRuntimeEnv; Variables: AkentrosVariables };
export type AkentrosContext = Context<AkentrosEnv>;
export type AkentrosNext = Next;
