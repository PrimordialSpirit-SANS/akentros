import type { BeaconRuntimeEnv } from "../types.ts";
import { randomBytesHex } from "./crypto.ts";
import { dbGet, dbQuery } from "./db.ts";

// 內建帳號系統:開發者控制台與點數計費的最小使用者模型。
// 欄位集合涵蓋 packages/core/src/billing.ts(扣點)與 aiApiKeys.ts(金鑰查驗)
// 實際讀取的欄位,不可任意改名。

// OWASP Password Storage Cheat Sheet 對 PBKDF2-HMAC-SHA256 的建議值
// (600,000)。舊格式雜湊仍可驗證:迭代數記錄在雜湊字串本身。
export const BEACON_PASSWORD_ITERATIONS = 600_000;

export interface BeaconAccount {
  id: string;
  username: string;
  email: string;
  display_name: string;
  role: string;
  balanceUsdMicros: string;
  is_banned: boolean;
  is_flagged: boolean;
  restricted_services: unknown;
}

// PBKDF2-SHA256。格式:pbkdf2$<iterations>$<salt_hex>$<hash_hex>
export async function hashPassword(password: string, env: BeaconRuntimeEnv): Promise<string> {
  const configured = Number(env?.BEACON_PBKDF2_ITERATIONS);
  const iterations =
    Number.isSafeInteger(configured) && configured >= 10_000 ? configured : BEACON_PASSWORD_ITERATIONS;
  const salt = randomBytesHex(16);
  const derived = await derivePasswordBits(password, salt, iterations);
  return `pbkdf2$${iterations}$${salt}$${derived}`;
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const [scheme, iterationsText, salt, hash] = String(stored).split("$");
  if (scheme !== "pbkdf2" || !iterationsText || !salt || !hash) return false;
  const iterations = Number(iterationsText);
  // 本系統產生的雜湊迭代數一律 ≥ BEACON_PASSWORD_ITERATIONS(歷史版本)或
  // 設定下限 10,000;低於下限的「雜湊」不是本系統寫入的,拒絕以免弱雜湊被
  // 塞進資料庫後通過驗證。
  if (!Number.isSafeInteger(iterations) || iterations < 10_000) return false;
  const derived = await derivePasswordBits(password, salt, iterations);
  // 常數時間比較,避免逐位元洩漏。
  if (derived.length !== hash.length) return false;
  let difference = 0;
  for (let index = 0; index < derived.length; index += 1) {
    difference |= derived.charCodeAt(index) ^ hash.charCodeAt(index);
  }
  return difference === 0;
}

async function derivePasswordBits(password: string, saltHex: string, iterations: number): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      // salt 以 hex 字串直接當輸入,避免依賴 Buffer。
      salt: new TextEncoder().encode(saltHex),
      iterations,
      hash: "SHA-256",
    },
    keyMaterial,
    256,
  );
  return [...new Uint8Array(bits)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function serializeAccount(row: any): BeaconAccount {
  return {
    id: String(row.id),
    username: String(row.username || ""),
    email: String(row.email || ""),
    display_name: String(row.display_name || ""),
    role: String(row.role || "user"),
    balanceUsdMicros: String(row.balance_usd_micros ?? "0"),
    is_banned: Boolean(row.is_banned),
    is_flagged: Boolean(row.is_flagged),
    restricted_services: row.restricted_services,
  };
}

export async function ensureUsersSchema(env: BeaconRuntimeEnv): Promise<void> {
  await dbQuery(
    env,
    `
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      balance_usd_micros INTEGER NOT NULL DEFAULT 0,
      is_banned INTEGER NOT NULL DEFAULT 0,
      is_flagged INTEGER NOT NULL DEFAULT 0,
      restricted_services TEXT NOT NULL DEFAULT '[]',
      display_name TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `,
  );
}

export async function findUserByEmail(env: BeaconRuntimeEnv, email: string): Promise<BeaconAccount | null> {
  const row = await dbGet(env, `SELECT * FROM users WHERE email = ? LIMIT 1`, [email.trim().toLowerCase()]);
  return row ? serializeAccount(row) : null;
}

export async function findUserById(
  env: BeaconRuntimeEnv,
  id: string | number,
): Promise<BeaconAccount | null> {
  if (!/^[1-9][0-9]*$/.test(String(id))) return null;
  const row = await dbGet(env, `SELECT * FROM users WHERE id = ? LIMIT 1`, [String(id)]);
  return row ? serializeAccount(row) : null;
}

export async function findUserPasswordHash(env: BeaconRuntimeEnv, email: string): Promise<string | null> {
  const row = await dbGet(env, `SELECT password_hash FROM users WHERE email = ? LIMIT 1`, [
    email.trim().toLowerCase(),
  ]);
  return row ? String(row.password_hash || "") : null;
}

export async function createUser(
  env: BeaconRuntimeEnv,
  options: {
    email: string;
    username: string;
    passwordHash: string;
    role?: string;
    balanceUsdMicros?: string;
  },
): Promise<BeaconAccount> {
  const row = await dbGet(
    env,
    `
    INSERT INTO users (username, email, password_hash, role, balance_usd_micros)
    VALUES (?, ?, ?, ?, ?)
    RETURNING *
  `,
    [
      options.username,
      options.email.trim().toLowerCase(),
      options.passwordHash,
      options.role || "user",
      String(options.balanceUsdMicros ?? "0"),
    ],
  );
  if (!row) throw new Error("Failed to create user.");
  return serializeAccount(row);
}

// migrate script 的管理員種子:已存在時僅確保 role = admin,不覆寫密碼。
export async function upsertAdminUser(
  env: BeaconRuntimeEnv,
  options: { email: string; passwordHash: string; username: string; balanceUsdMicros: string },
): Promise<{ created: boolean }> {
  const existing = await dbGet(env, `SELECT id, role FROM users WHERE email = ? LIMIT 1`, [
    options.email.trim().toLowerCase(),
  ]);
  if (existing) {
    await dbQuery(
      env,
      `UPDATE users SET role = 'admin', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
      [String(existing.id)],
    );
    return { created: false };
  }
  await createUser(env, {
    email: options.email,
    username: options.username,
    passwordHash: options.passwordHash,
    role: "admin",
    balanceUsdMicros: options.balanceUsdMicros,
  });
  return { created: true };
}
