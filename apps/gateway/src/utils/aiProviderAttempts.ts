import { createBeaconProviderAttemptStore } from "@beacon/core/providerAttempts";
import type { BeaconRuntimeEnv } from "../types.ts";
import { ensureAiSchema } from "./aiSchema.ts";
import { createBeaconQuery } from "./db.ts";

const stores = new Map();

function storeFor(env: BeaconRuntimeEnv) {
  const key = env?.DATABASE_URL?.trim() || "unconfigured-main";
  if (!stores.has(key)) {
    stores.set(key, createBeaconProviderAttemptStore(createBeaconQuery(env)));
  }
  return stores.get(key);
}

export async function startBeaconProviderAttempt(env: BeaconRuntimeEnv, input: any) {
  await ensureAiSchema(env);
  return storeFor(env).start(input);
}

export async function finishBeaconProviderAttempt(env: BeaconRuntimeEnv, attempt: any, outcome: any) {
  await ensureAiSchema(env);
  return storeFor(env).finish(attempt, outcome);
}
