import { createBeaconDeveloperUsageStore } from "@beacon/core/developerUsage";
import type { BeaconRuntimeEnv } from "../types.ts";
import { ensureAiSchema } from "./aiSchema.ts";
import { createBeaconQuery } from "./db.ts";

const stores = new Map();

function storeFor(env: BeaconRuntimeEnv) {
  const key = env?.DATABASE_URL?.trim() || "unconfigured-main";
  if (!stores.has(key)) {
    stores.set(key, createBeaconDeveloperUsageStore(createBeaconQuery(env)));
  }
  return stores.get(key);
}

export async function getBeaconUsageSummary(env: BeaconRuntimeEnv, userId: any) {
  await ensureAiSchema(env);
  return storeFor(env).summary(userId);
}

export async function listBeaconUsageLogs(env: BeaconRuntimeEnv, userId: any, options: any) {
  await ensureAiSchema(env);
  return storeFor(env).list(userId, options);
}

export async function getBeaconUsageDetail(env: BeaconRuntimeEnv, userId: any, requestId: any) {
  await ensureAiSchema(env);
  return storeFor(env).detail(userId, requestId);
}
