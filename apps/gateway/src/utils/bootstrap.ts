import type { AkentrosRuntimeEnv } from "../types.ts";
// 共用的 schema/帳號 bootstrap:Node 的 migrate script 與 Cloudflare Workers
// 的 Durable Object 首次啟動共用同一套流程,確保兩種部署形態的資料庫狀態一致。
//   1. point_transactions(AI 計費流水的平台層底表)
//   2. Akentros schema(版本化遷移)
//   3. users(內建帳號系統)+ 可選管理員種子(ADMIN_EMAIL / ADMIN_PASSWORD)

import { parseUsdToMicros } from "@akentros/core/pricing";
import { migrateAkentrosSchema } from "@akentros/core/schemaMigration";
import { createAkentrosQuery } from "./db.ts";
import { ensureLedgerSchema } from "./ledger.ts";
import { ensureUsersSchema, hashPassword, upsertAdminUser } from "./users.ts";

export async function ensureAkentrosSchemaReady(env: AkentrosRuntimeEnv): Promise<{ migrated: boolean }> {
  await ensureLedgerSchema(env);
  // 以 createAkentrosQuery(env) 提供 dialect 標註:遷移 DDL 與就緒檢查依此
  // 選擇 SQLite/PostgreSQL 的 catalog 語法(裸函式包裝會被誤判為 SQLite)。
  const result = await migrateAkentrosSchema(createAkentrosQuery(env));
  await ensureUsersSchema(env);
  return { migrated: result.migrated };
}

export async function seedAkentrosAdminFromEnv(
  env: AkentrosRuntimeEnv,
): Promise<{ created: boolean } | null> {
  const adminEmail = env?.ADMIN_EMAIL?.trim();
  const adminPassword = env?.ADMIN_PASSWORD;
  if (!adminEmail || !adminPassword) return null;
  if (adminPassword.length < 8) {
    throw new Error("ADMIN_PASSWORD must be at least 8 characters.");
  }
  const passwordHash = await hashPassword(adminPassword, env);
  const { created } = await upsertAdminUser(env, {
    email: adminEmail,
    passwordHash,
    username: env?.ADMIN_USERNAME?.trim() || "admin",
    balanceUsdMicros: parseUsdToMicros(
      env?.AKENTROS_ADMIN_STARTING_CREDITS_USD ?? "500.00",
      "AKENTROS_ADMIN_STARTING_CREDITS_USD",
    ).toString(),
  });
  return { created };
}
