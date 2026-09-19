import {
  AKENTROS_DEFAULT_SCOPES,
  AKENTROS_MAX_ACTIVE_KEYS,
  isAkentrosApiKey,
  maskAkentrosApiKey,
  normalizeAkentrosKeyOptions,
  parseAkentrosJsonArray,
  parseAkentrosModelAllowlistStrict,
  requireAkentrosApiKeyPepper,
  serializeAkentrosApiKey,
} from "@akentros/core/apiKeys";
import { listEnabledModels } from "@akentros/core/pricing";
import type { AkentrosAuthenticatedKey, AkentrosRuntimeEnv } from "../types.ts";
import { ensureAiSchema } from "./aiSchema.ts";
import { hmacSha256Hex, randomToken, sha256Hex } from "./crypto.ts";
import { createAkentrosQuery, dbGet, dbQuery, withAkentrosTransaction } from "./db.ts";

// authenticateAkentrosApiKey 的 SELECT 欄位契約:資料列欄位以此為準,
// 讀取 SELECT 以外的欄位會在編譯期報錯(防 row.points 這類幽靈欄位)。
interface AkentrosApiKeyAuthRow {
  id: number | string;
  user_id: number | string;
  name: string;
  key_prefix: string;
  key_suffix: string;
  scopes: unknown;
  model_allowlist: unknown;
  rpm_limit: number | string;
  max_in_flight: number | string;
  spend_limit_usd_micros: number | null;
  spend_used_usd_micros: number | string;
  idempotency_replay_ttl_seconds: number | string;
  expires_at: string | null;
  username: string;
  role: string;
  is_banned: number | boolean;
  is_flagged: number | boolean;
  restricted_services: unknown;
  balance_usd_micros: number | string;
}

function getPepper(env: AkentrosRuntimeEnv, explicitPepper: unknown) {
  return requireAkentrosApiKeyPepper(explicitPepper || env?.AKENTROS_API_KEY_PEPPER);
}

export function generateAkentrosApiKey(environment = "live") {
  const safeEnvironment = environment === "test" ? "test" : "live";
  return randomToken(`sk-akentros-${safeEnvironment}`, 32);
}

export function digestAkentrosApiKey(env: AkentrosRuntimeEnv, secret: unknown, explicitPepper?: unknown) {
  return hmacSha256Hex(getPepper(env, explicitPepper), String(secret));
}

export async function listAkentrosApiKeys(env: AkentrosRuntimeEnv, userId: string | number) {
  await ensureAiSchema(env);
  const result = await dbQuery(
    env,
    `
    SELECT id, name, environment, key_prefix, key_suffix, scopes, model_allowlist,
           rpm_limit, max_in_flight, spend_limit_usd_micros, spend_used_usd_micros,
           idempotency_replay_ttl_seconds, is_active, expires_at,
           last_used_at, rotated_at, revoked_at, created_at
    FROM ai_api_keys
    WHERE user_id = ?
      AND is_active = 1
      AND revoked_at IS NULL
      AND environment <> 'session'
    ORDER BY created_at DESC, id DESC
  `,
    [userId],
  );
  return (result.rows || []).map(serializeAkentrosApiKey);
}

function rows(result: any): any[] {
  return Array.isArray(result?.rows) ? result.rows : [];
}

function nowIso() {
  return new Date().toISOString();
}

function fiveMinutesAgoIso() {
  return new Date(Date.now() - 5 * 60_000).toISOString();
}

export async function ensureAkentrosSessionCredential(
  env: AkentrosRuntimeEnv,
  user: {
    id: string | number;
    username: string;
    role: string;
    is_flagged: boolean;
    restricted_services: unknown;
  },
): Promise<AkentrosAuthenticatedKey> {
  await ensureAiSchema(env);
  const userId = String(user?.id || "");
  if (!/^[1-9][0-9]*$/.test(userId)) {
    throw new TypeError("A valid user is required for Akentros account inference.");
  }

  // This deterministic digest is only a private row identity. It is never
  // returned as a bearer secret, and public-key authentication excludes
  // session credentials explicitly.
  const digest = await sha256Hex(`akentros-account-session:${userId}`);
  const row = await dbGet(
    env,
    `
    INSERT INTO ai_api_keys (
      user_id, name, environment, key_prefix, key_suffix, key_digest,
      scopes, model_allowlist, rpm_limit, max_in_flight, spend_limit_usd_micros,
      is_active, expires_at, last_used_at
    )
    VALUES (?, 'Akentros account session', 'session', 'akentros-account', 'session', ?,
            ?, '[]', 60, 4, NULL, 1, NULL, ?)
    ON CONFLICT (key_digest) DO UPDATE
    SET is_active = 1,
        revoked_at = NULL,
        last_used_at = CASE
          WHEN ai_api_keys.last_used_at IS NULL
            OR ai_api_keys.last_used_at < ?
          THEN ?
          ELSE ai_api_keys.last_used_at
        END,
        updated_at = ?
    WHERE ai_api_keys.user_id = EXCLUDED.user_id
      AND ai_api_keys.environment = 'session'
    RETURNING id, user_id, name, scopes, model_allowlist, rpm_limit,
              max_in_flight, spend_limit_usd_micros, spend_used_usd_micros
  `,
    [
      userId,
      digest,
      JSON.stringify(AKENTROS_DEFAULT_SCOPES),
      nowIso(),
      fiveMinutesAgoIso(),
      nowIso(),
      nowIso(),
    ],
  );

  if (!row) {
    throw new Error("Akentros account session credential is unavailable.");
  }

  return {
    id: String(row.id),
    user_id: row.user_id,
    name: row.name,
    scopes: parseAkentrosJsonArray(row.scopes),
    model_allowlist: parseAkentrosJsonArray(row.model_allowlist),
    rpm_limit: Number(row.rpm_limit),
    max_in_flight: Number(row.max_in_flight),
    spend_limit_usd_micros: row.spend_limit_usd_micros == null ? null : Number(row.spend_limit_usd_micros),
    spend_used_usd_micros: Number(row.spend_used_usd_micros || 0),
    idempotency_replay_ttl_seconds: Number(row.idempotency_replay_ttl_seconds || 0),
    user: {
      id: row.user_id,
      username: user.username,
      role: user.role,
      is_banned: false,
      is_flagged: Boolean(user.is_flagged),
      restricted_services: user.restricted_services,
    },
  };
}

export async function createAkentrosApiKey(
  env: AkentrosRuntimeEnv,
  userId: string | number,
  options: Record<string, unknown>,
) {
  await ensureAiSchema(env);
  const clean = normalizeAkentrosKeyOptions(
    options,
    listEnabledModels().map((model) => model.id),
  );
  const secret = generateAkentrosApiKey(clean.environment);
  const digest = await digestAkentrosApiKey(env, secret);
  const mask = maskAkentrosApiKey(secret);
  const query = createAkentrosQuery(env);
  const result = await withAkentrosTransaction(env, async () => {
    const now = nowIso();
    const activeCountRows = await query(
      `
      SELECT COUNT(*) AS active_count
      FROM ai_api_keys
      WHERE user_id = ?
        AND is_active = 1
        AND revoked_at IS NULL
        AND environment <> 'session'
        AND (expires_at IS NULL OR expires_at > ?)
    `,
      [userId, now],
    );
    const activeCount = Number(rows(activeCountRows)[0]?.active_count || 0);
    if (activeCount >= AKENTROS_MAX_ACTIVE_KEYS) return { rows: [] };

    return query(
      `
      INSERT INTO ai_api_keys (
        user_id, name, environment, key_prefix, key_suffix, key_digest,
        scopes, model_allowlist, rpm_limit, max_in_flight, spend_limit_usd_micros, expires_at,
        idempotency_replay_ttl_seconds
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id, name, environment, key_prefix, key_suffix, scopes, model_allowlist,
                rpm_limit, max_in_flight, spend_limit_usd_micros, spend_used_usd_micros,
                idempotency_replay_ttl_seconds, is_active, expires_at,
                last_used_at, rotated_at, revoked_at, created_at
    `,
      [
        userId,
        clean.name,
        clean.environment,
        mask.key_prefix,
        mask.key_suffix,
        digest,
        JSON.stringify(AKENTROS_DEFAULT_SCOPES),
        JSON.stringify(clean.modelAllowlist),
        clean.rpmLimit,
        clean.maxInFlight,
        clean.spendLimitUsdMicros,
        clean.expiresAt,
        clean.idempotencyReplayTtlSeconds,
      ],
    );
  });
  if (!result.rows?.[0]) {
    const error: Error & { code?: string } = new Error(
      `A maximum of ${AKENTROS_MAX_ACTIVE_KEYS} active Akentros keys is allowed.`,
    );
    error.code = "AI_KEY_LIMIT";
    throw error;
  }
  return { ...serializeAkentrosApiKey(result.rows[0]), secret };
}

export async function rotateAkentrosApiKey(
  env: AkentrosRuntimeEnv,
  userId: string | number,
  keyId: string | number,
) {
  await ensureAiSchema(env);
  const existing = await dbGet(
    env,
    `SELECT id, environment
     FROM ai_api_keys
     WHERE id = ? AND user_id = ? AND is_active = 1 AND environment <> 'session'`,
    [keyId, userId],
  );
  if (!existing) return null;

  const secret = generateAkentrosApiKey(existing.environment);
  const digest = await digestAkentrosApiKey(env, secret);
  const mask = maskAkentrosApiKey(secret);
  const result = await dbQuery(
    env,
    `
    UPDATE ai_api_keys
    SET key_prefix = ?, key_suffix = ?, key_digest = ?, rotated_at = ?,
        last_used_at = NULL, updated_at = ?
    WHERE id = ? AND user_id = ? AND is_active = 1 AND environment <> 'session'
    RETURNING id, name, environment, key_prefix, key_suffix, scopes, model_allowlist,
              rpm_limit, max_in_flight, spend_limit_usd_micros, spend_used_usd_micros,
              idempotency_replay_ttl_seconds, is_active, expires_at,
              last_used_at, rotated_at, revoked_at, created_at
  `,
    [mask.key_prefix, mask.key_suffix, digest, nowIso(), nowIso(), keyId, userId],
  );
  return result.rows?.[0] ? { ...serializeAkentrosApiKey(result.rows[0]), secret } : null;
}

export async function revokeAkentrosApiKey(
  env: AkentrosRuntimeEnv,
  userId: string | number,
  keyId: string | number,
) {
  await ensureAiSchema(env);
  const result = await dbQuery(
    env,
    `
    UPDATE ai_api_keys
    SET is_active = 0, revoked_at = COALESCE(revoked_at, ?), updated_at = ?
    WHERE id = ? AND user_id = ? AND environment <> 'session'
    RETURNING id
  `,
    [nowIso(), nowIso(), keyId, userId],
  );
  return Boolean(result.rows?.length);
}

export async function authenticateAkentrosApiKey(
  env: AkentrosRuntimeEnv,
  secret: unknown,
): Promise<AkentrosAuthenticatedKey | null> {
  if (!isAkentrosApiKey(secret)) return null;
  await ensureAiSchema(env);
  const digest = await digestAkentrosApiKey(env, secret);
  const row = (await dbGet(
    env,
    `
    SELECT keys.id, keys.user_id, keys.name, keys.key_prefix, keys.key_suffix,
           keys.scopes, keys.model_allowlist, keys.rpm_limit, keys.max_in_flight,
           keys.spend_limit_usd_micros, keys.spend_used_usd_micros, keys.expires_at,
           keys.idempotency_replay_ttl_seconds,
           users.username, users.role, users.is_banned, users.is_flagged,
           users.restricted_services, users.balance_usd_micros
    FROM ai_api_keys AS keys
    JOIN users ON users.id = keys.user_id
    WHERE keys.key_digest = ?
      AND keys.environment <> 'session'
      AND keys.is_active = 1
      AND keys.revoked_at IS NULL
      AND (keys.expires_at IS NULL OR keys.expires_at > ?)
    LIMIT 1
  `,
    // expires_at 存的是 ISO-8601 字串;CURRENT_TIMESTAMP 是空格分隔格式,
    // 字典序比較會讓「當天到期」整日視為未過期,必須用同格式的 now 綁定比較。
    [digest, nowIso()],
  )) as AkentrosApiKeyAuthRow | null;
  if (!row) return null;
  // model_allowlist 損毀時 fail-closed:回 null(視同無效金鑰),而不是把
  // 損毀值當成空陣列 = 解除所有模型限制。
  const modelAllowlist = parseAkentrosModelAllowlistStrict(row.model_allowlist);
  if (!modelAllowlist) return null;
  await dbQuery(
    env,
    `
    UPDATE ai_api_keys
    SET last_used_at = ?, updated_at = ?
    WHERE id = ?
      AND (last_used_at IS NULL OR last_used_at < ?)
  `,
    [nowIso(), nowIso(), row.id, fiveMinutesAgoIso()],
  );
  return {
    id: String(row.id),
    user_id: row.user_id,
    name: row.name,
    prefix: row.key_prefix,
    suffix: row.key_suffix,
    scopes: parseAkentrosJsonArray(row.scopes),
    model_allowlist: modelAllowlist,
    rpm_limit: Number(row.rpm_limit),
    max_in_flight: Number(row.max_in_flight),
    spend_limit_usd_micros: row.spend_limit_usd_micros == null ? null : Number(row.spend_limit_usd_micros),
    spend_used_usd_micros: Number(row.spend_used_usd_micros || 0),
    idempotency_replay_ttl_seconds: Number(row.idempotency_replay_ttl_seconds || 0),
    user: {
      id: String(row.user_id),
      username: row.username,
      role: row.role,
      is_banned: Boolean(row.is_banned),
      is_flagged: Boolean(row.is_flagged),
      restricted_services: row.restricted_services,
    },
  };
}
