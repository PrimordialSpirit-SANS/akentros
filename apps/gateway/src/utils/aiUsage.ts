import { createBeaconDeveloperUsageStore } from "../../../../packages/core/src/developerUsage.ts";
import { ensureAiSchema } from "./aiSchema.ts";
import { createBeaconQuery } from "./db.ts";

const stores = new Map();

function storeFor(env: any) {
  const key = env?.POSTGRES_DB_URL?.trim() || env?.DATABASE_URL?.trim() || "unconfigured-main";
  if (!stores.has(key)) {
    stores.set(key, createBeaconDeveloperUsageStore(createBeaconQuery(env)));
  }
  return stores.get(key);
}

export async function getBeaconUsageSummary(env: any, userId: any) {
  await ensureAiSchema(env);
  return storeFor(env).summary(userId);
}

export async function listBeaconUsageLogs(env: any, userId: any, options: any) {
  await ensureAiSchema(env);
  return storeFor(env).list(userId, options);
}

export async function getBeaconUsageDetail(env: any, userId: any, requestId: any) {
  await ensureAiSchema(env);
  return storeFor(env).detail(userId, requestId);
}
