import { createBeaconApiLimitStore } from "@beacon/core/apiLimits";
import type { BeaconRuntimeEnv } from "../types.ts";
import { ensureAiSchema } from "./aiSchema.ts";
import { createBeaconQuery } from "./db.ts";

const stores = new Map();

function storeFor(env: BeaconRuntimeEnv) {
  const key = env?.DATABASE_URL?.trim() || "unconfigured-main";
  if (!stores.has(key)) {
    stores.set(key, createBeaconApiLimitStore(createBeaconQuery(env)));
  }
  return stores.get(key);
}

export async function acquireBeaconApiLimit(env: BeaconRuntimeEnv, input: any) {
  await ensureAiSchema(env);
  return storeFor(env).acquire(input);
}

export async function releaseBeaconApiLimit(env: BeaconRuntimeEnv, requestId: any) {
  await ensureAiSchema(env);
  return storeFor(env).release(requestId);
}
