import { createBeaconApiLimitStore } from "../../../../packages/core/src/apiLimits.ts";
import { ensureAiSchema } from "./aiSchema.ts";
import { createBeaconQuery } from "./db.ts";

const stores = new Map();

function storeFor(env: any) {
  const key = env?.POSTGRES_DB_URL?.trim() || env?.DATABASE_URL?.trim() || "unconfigured-main";
  if (!stores.has(key)) {
    stores.set(key, createBeaconApiLimitStore(createBeaconQuery(env)));
  }
  return stores.get(key);
}

export async function acquireBeaconApiLimit(env: any, input: any) {
  await ensureAiSchema(env);
  return storeFor(env).acquire(input);
}

export async function releaseBeaconApiLimit(env: any, requestId: any) {
  await ensureAiSchema(env);
  return storeFor(env).release(requestId);
}
