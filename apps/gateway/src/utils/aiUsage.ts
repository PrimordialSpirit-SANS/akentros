import { createAkentrosDeveloperUsageStore } from "@akentros/core/developerUsage";
import type { AkentrosRuntimeEnv } from "../types.ts";
import { ensureAiSchema } from "./aiSchema.ts";
import { createAkentrosQuery } from "./db.ts";

const stores = new Map();

function storeFor(env: AkentrosRuntimeEnv) {
  // SN-13 fix:與 rateLimit 的 limiterStoreKey 對齊,額外涵蓋
  // AKENTROS_DB_PATH —— 單行程多 SQLite 路徑(測試情境)時,
  // 只認 DATABASE_URL 會讓不同路徑共用同一個 store(錯的 query 閉包)。
  const key = env?.DATABASE_URL?.trim() || env?.AKENTROS_DB_PATH?.trim() || "unconfigured-main";
  if (!stores.has(key)) {
    stores.set(key, createAkentrosDeveloperUsageStore(createAkentrosQuery(env)));
  }
  return stores.get(key);
}

export async function getAkentrosUsageSummary(env: AkentrosRuntimeEnv, userId: any) {
  await ensureAiSchema(env);
  return storeFor(env).summary(userId);
}

export async function listAkentrosUsageLogs(env: AkentrosRuntimeEnv, userId: any, options: any) {
  await ensureAiSchema(env);
  return storeFor(env).list(userId, options);
}

export async function getAkentrosUsageDetail(env: AkentrosRuntimeEnv, userId: any, requestId: any) {
  await ensureAiSchema(env);
  return storeFor(env).detail(userId, requestId);
}
