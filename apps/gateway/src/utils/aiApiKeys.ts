import {
  BEACON_DEFAULT_SCOPES,
  BEACON_MAX_ACTIVE_KEYS,
  isBeaconApiKey,
  maskBeaconApiKey,
  normalizeBeaconKeyOptions,
  parseBeaconJsonArray,
  parseBeaconModelAllowlistStrict,
  requireBeaconApiKeyPepper,
  serializeBeaconApiKey,
} from "../../../../packages/core/src/apiKeys.ts";
import { listEnabledModels } from "../../../../packages/core/src/pricing.ts";
import { ensureAiSchema } from "./aiSchema.ts";
import { hmacSha256Hex, randomToken, sha256Hex } from "./crypto.ts";
import { createBeaconQuery, dbGet, dbQuery, withBeaconTransaction } from "./db.ts";

function getPepper(env: any, explicitPepper: any) {
  return requireBeaconApiKeyPepper(explicitPepper || env?.BEACON_API_KEY_PEPPER);
}

export function generateBeaconApiKey(environment = "live") {
  const safeEnvironment = environment === "test" ? "test" : "live";
  return randomToken(`sk-beacon-${safeEnvironment}`, 32);
}

export function digestBeaconApiKey(env: any, secret: any, explicitPepper?: any) {
  return hmacSha256Hex(getPepper(env, explicitPepper), String(secret));
}

export async function listBeaconApiKeys(env: any, userId: any) {
  await ensureAiSchema(env);
  const result = await dbQuery(
    env,
    `
    SELECT id, name, environment, key_prefix, key_suffix, scopes, model_allowlist,
           rpm_limit, max_in_flight, spend_limit_usd_micros, spend_used_usd_micros,
           is_active, expires_at,
           last_used_at, rotated_at, revoked_at, created_at
    FROM ai_api_keys
    WHERE user_id = ?
      AND is_active = TRUE
      AND revoked_at IS NULL
      AND environment <> 'session'
    ORDER BY created_at DESC, id DESC
  `,
    [userId],
  );
  return (result.rows || []).map(serializeBeaconApiKey);
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

export async function ensureBeaconSessionCredential(env: any, user: any) {
  await ensureAiSchema(env);
  const userId = String(user?.id || "");
  if (!/^[1-9][0-9]*$/.test(userId)) {
    throw new TypeError("A valid user is required for Beacon account inference.");
  }

  // This deterministic digest is only a private row identity. It is never
  // returned as a bearer secret, and public-key authentication excludes
  // session credentials explicitly.
  const digest = await sha256Hex(`beacon-account-session:${userId}`);
  const row = await dbGet(
    env,
    `
    INSERT INTO ai_api_keys (
      user_id, name, environment, key_prefix, key_suffix, key_digest,
      scopes, model_allowlist, rpm_limit, max_in_flight, spend_limit_usd_micros,
      is_active, expires_at, last_used_at
    )
    VALUES (?, 'Beacon account session', 'session', 'beacon-account', 'session', ?,
            ?, '[]', 60, 4, NULL, TRUE, NULL, ?)
    ON CONFLICT (key_digest) DO UPDATE
    SET is_active = TRUE,
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
      JSON.stringify(BEACON_DEFAULT_SCOPES),
      nowIso(),
      fiveMinutesAgoIso(),
      nowIso(),
      nowIso(),
    ],
  );

  if (!row) {
    throw new Error("Beacon account session credential is unavailable.");
  }

  return {
    id: String(row.id),
    user_id: row.user_id,
    name: row.name,
    scopes: parseBeaconJsonArray(row.scopes),
    model_allowlist: parseBeaconJsonArray(row.model_allowlist),
    rpm_limit: Number(row.rpm_limit),
    max_in_flight: Number(row.max_in_flight),
    spend_limit_usd_micros: row.spend_limit_usd_micros == null ? null : Number(row.spend_limit_usd_micros),
    spend_used_usd_micros: Number(row.spend_used_usd_micros || 0),
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

export async function createBeaconApiKey(env: any, userId: any, options: any) {
  await ensureAiSchema(env);
  const clean = normalizeBeaconKeyOptions(
    options,
    listEnabledModels().map((model) => model.id),
  );
  const secret = generateBeaconApiKey(clean.environment);
  const digest = await digestBeaconApiKey(env, secret);
  const mask = maskBeaconApiKey(secret);
  const query = createBeaconQuery(env);
  const result = await withBeaconTransaction(env, async () => {
    const now = nowIso();
    const activeCountRows = await query(
      `
      SELECT COUNT(*) AS active_count
      FROM ai_api_keys
      WHERE user_id = ?
        AND is_active = TRUE
        AND revoked_at IS NULL
        AND environment <> 'session'
        AND (expires_at IS NULL OR expires_at > ?)
    `,
      [userId, now],
    );
    const activeCount = Number(rows(activeCountRows)[0]?.active_count || 0);
    if (activeCount >= BEACON_MAX_ACTIVE_KEYS) return { rows: [] };

    return query(
      `
      INSERT INTO ai_api_keys (
        user_id, name, environment, key_prefix, key_suffix, key_digest,
        scopes, model_allowlist, rpm_limit, max_in_flight, spend_limit_usd_micros, expires_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id, name, environment, key_prefix, key_suffix, scopes, model_allowlist,
                rpm_limit, max_in_flight, spend_limit_usd_micros, spend_used_usd_micros,
                is_active, expires_at,
                last_used_at, rotated_at, revoked_at, created_at
    `,
      [
        userId,
        clean.name,
        clean.environment,
        mask.key_prefix,
        mask.key_suffix,
        digest,
        JSON.stringify(BEACON_DEFAULT_SCOPES),
        JSON.stringify(clean.modelAllowlist),
        clean.rpmLimit,
        clean.maxInFlight,
        clean.spendLimitUsdMicros,
        clean.expiresAt,
      ],
    );
  });
  if (!result.rows?.[0]) {
    const error: Error & { code?: string } = new Error(
      `A maximum of ${BEACON_MAX_ACTIVE_KEYS} active Beacon keys is allowed.`,
    );
    error.code = "AI_KEY_LIMIT";
    throw error;
  }
  return { ...serializeBeaconApiKey(result.rows[0]), secret };
}

export async function rotateBeaconApiKey(env: any, userId: any, keyId: any) {
  await ensureAiSchema(env);
  const existing = await dbGet(
    env,
    `SELECT id, environment
     FROM ai_api_keys
     WHERE id = ? AND user_id = ? AND is_active = TRUE AND environment <> 'session'`,
    [keyId, userId],
  );
  if (!existing) return null;

  const secret = generateBeaconApiKey(existing.environment);
  const digest = await digestBeaconApiKey(env, secret);
  const mask = maskBeaconApiKey(secret);
  const result = await dbQuery(
    env,
    `
    UPDATE ai_api_keys
    SET key_prefix = ?, key_suffix = ?, key_digest = ?, rotated_at = ?,
        last_used_at = NULL, updated_at = ?
    WHERE id = ? AND user_id = ? AND is_active = TRUE AND environment <> 'session'
    RETURNING id, name, environment, key_prefix, key_suffix, scopes, model_allowlist,
              rpm_limit, max_in_flight, spend_limit_usd_micros, spend_used_usd_micros,
              is_active, expires_at,
              last_used_at, rotated_at, revoked_at, created_at
  `,
    [mask.key_prefix, mask.key_suffix, digest, nowIso(), nowIso(), keyId, userId],
  );
  return result.rows?.[0] ? { ...serializeBeaconApiKey(result.rows[0]), secret } : null;
}

export async function revokeBeaconApiKey(env: any, userId: any, keyId: any) {
  await ensureAiSchema(env);
  const result = await dbQuery(
    env,
    `
    UPDATE ai_api_keys
    SET is_active = FALSE, revoked_at = COALESCE(revoked_at, ?), updated_at = ?
    WHERE id = ? AND user_id = ? AND environment <> 'session'
    RETURNING id
  `,
    [nowIso(), nowIso(), keyId, userId],
  );
  return Boolean(result.rows?.length);
}

export async function authenticateBeaconApiKey(env: any, secret: any) {
  if (!isBeaconApiKey(secret)) return null;
  await ensureAiSchema(env);
  const digest = await digestBeaconApiKey(env, secret);
  const row = await dbGet(
    env,
    `
    SELECT keys.id, keys.user_id, keys.name, keys.key_prefix, keys.key_suffix,
           keys.scopes, keys.model_allowlist, keys.rpm_limit, keys.max_in_flight,
           keys.spend_limit_usd_micros, keys.spend_used_usd_micros, keys.expires_at,
           users.username, users.role, users.is_banned, users.is_flagged,
           users.restricted_services, users.balance_usd_micros
    FROM ai_api_keys AS keys
    JOIN users ON users.id = keys.user_id
    WHERE keys.key_digest = ?
      AND keys.environment <> 'session'
      AND keys.is_active = TRUE
      AND keys.revoked_at IS NULL
      AND (keys.expires_at IS NULL OR keys.expires_at > CURRENT_TIMESTAMP)
    LIMIT 1
  `,
    [digest],
  );
  if (!row) return null;
  // model_allowlist 損毀時 fail-closed:回 null(視同無效金鑰),而不是把
  // 損毀值當成空陣列 = 解除所有模型限制。
  const modelAllowlist = parseBeaconModelAllowlistStrict(row.model_allowlist);
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
    scopes: parseBeaconJsonArray(row.scopes),
    model_allowlist: modelAllowlist,
    rpm_limit: Number(row.rpm_limit),
    max_in_flight: Number(row.max_in_flight),
    spend_limit_usd_micros: row.spend_limit_usd_micros == null ? null : Number(row.spend_limit_usd_micros),
    spend_used_usd_micros: Number(row.spend_used_usd_micros || 0),
    user: {
      id: row.user_id,
      username: row.username,
      role: row.role,
      is_banned: Boolean(row.is_banned),
      is_flagged: Boolean(row.is_flagged),
      restricted_services: row.restricted_services,
      points: Number(row.points),
    },
  };
}
