import type { AkentrosRuntimeEnv } from "../types.ts";
// 共用的 schema/帳號 bootstrap:Node 的 migrate script 與 Cloudflare Workers
// 的 Durable Object 首次啟動共用同一套流程,確保兩種部署形態的資料庫狀態一致。
//   1. point_transactions(AI 計費流水的平台層底表)
//   2. users(內建帳號系統)—— 必須先於版本化遷移:v4 對 users 做
//      ALTER ADD COLUMN session_epoch(SEC-01),與 v1 的 ledger_entries
//      部分唯一索引依賴底表先存在是同一前置模式
//   3. Akentros schema(版本化遷移)
// 可選管理員種子(ADMIN_EMAIL / ADMIN_PASSWORD)由 seedAkentrosAdminFromEnv
// 在此之後執行(呼叫端:migrate script、DO 首次啟動)。

import { parseUsdToMicros } from "@akentros/core/pricing";
import { migrateAkentrosSchema } from "@akentros/core/schemaMigration";
import { createAkentrosQuery } from "./db.ts";
import { ensureLedgerSchema } from "./ledger.ts";
import { ensureUsersSchema, hashPassword, upsertAdminUser } from "./users.ts";

export async function ensureAkentrosSchemaReady(env: AkentrosRuntimeEnv): Promise<{ migrated: boolean }> {
  await ensureLedgerSchema(env);
  // users 先建、遷移後跑:v4 的 ALTER TABLE users ADD COLUMN session_epoch
  // 需要底表存在(users 基礎 DDL 不含該欄位,統一由 v4 加入,讓 fresh/
  // upgrade 兩條路徑行為一致 —— 見 packages/core/src/schemaMigration.ts)。
  await ensureUsersSchema(env);
  // 以 createAkentrosQuery(env) 提供 dialect 標註:遷移 DDL 與就緒檢查依此
  // 選擇 SQLite/PostgreSQL 的 catalog 語法(裸函式包裝會被誤判為 SQLite)。
  const result = await migrateAkentrosSchema(createAkentrosQuery(env));
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
    // password 僅用於「既有帳號的擁有權驗證」(upsertAdminUser 內以
    // verifyPassword 比對,不入庫);passwordHash 僅在建立新帳號時落地。
    password: adminPassword,
    passwordHash,
    username: env?.ADMIN_USERNAME?.trim() || "admin",
    balanceUsdMicros: parseUsdToMicros(
      env?.AKENTROS_ADMIN_STARTING_CREDITS_USD ?? "500.00",
      "AKENTROS_ADMIN_STARTING_CREDITS_USD",
    ).toString(),
  });
  return { created };
}
