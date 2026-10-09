import type { AkentrosAttemptAuditor } from "@akentros/core/providerAttempts";
import { createAkentrosProviderAttemptStore } from "@akentros/core/providerAttempts";
import type { AkentrosRuntimeEnv } from "../types.ts";
import { ensureAiSchema } from "./aiSchema.ts";
import { createAkentrosQuery } from "./db.ts";

const stores = new Map<string, ReturnType<typeof createAkentrosProviderAttemptStore>>();

type AkentrosAttemptFinish = NonNullable<AkentrosAttemptAuditor["finish"]>;

function storeFor(env: AkentrosRuntimeEnv) {
  // SN-13 fix:與 rateLimit 的 limiterStoreKey 對齊,額外涵蓋
  // AKENTROS_DB_PATH —— 單行程多 SQLite 路徑(測試情境)時,
  // 只認 DATABASE_URL 會讓不同路徑共用同一個 store(錯的 query 閉包)。
  const key = env?.DATABASE_URL?.trim() || env?.AKENTROS_DB_PATH?.trim() || "unconfigured-main";
  if (!stores.has(key)) {
    stores.set(key, createAkentrosProviderAttemptStore(createAkentrosQuery(env)));
  }
  return stores.get(key)!;
}

export async function startAkentrosProviderAttempt(
  env: AkentrosRuntimeEnv,
  input: Parameters<AkentrosAttemptAuditor["start"]>[0],
) {
  await ensureAiSchema(env);
  return storeFor(env).start(input);
}

export async function finishAkentrosProviderAttempt(
  env: AkentrosRuntimeEnv,
  attempt: unknown,
  outcome: Parameters<AkentrosAttemptFinish>[1],
) {
  await ensureAiSchema(env);
  return storeFor(env).finish(attempt, outcome);
}
