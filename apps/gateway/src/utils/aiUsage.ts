import { createAkentrosDeveloperUsageStore } from "@akentros/core/developerUsage";
import type { AkentrosRuntimeEnv } from "../types.ts";
import { ensureAiSchema } from "./aiSchema.ts";
import { createAkentrosQuery } from "./db.ts";

const stores = new Map();

function storeFor(env: AkentrosRuntimeEnv) {
  const key = env?.DATABASE_URL?.trim() || "unconfigured-main";
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
