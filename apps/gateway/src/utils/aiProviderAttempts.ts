import { createBeaconProviderAttemptStore } from "../../../../packages/core/src/providerAttempts.ts";
import { ensureAiSchema } from "./aiSchema.ts";
import { createBeaconQuery } from "./db.ts";

const stores = new Map();

function storeFor(env: any) {
  const key = env?.POSTGRES_DB_URL?.trim() || env?.DATABASE_URL?.trim() || "unconfigured-main";
  if (!stores.has(key)) {
    stores.set(key, createBeaconProviderAttemptStore(createBeaconQuery(env)));
  }
  return stores.get(key);
}

export async function startBeaconProviderAttempt(env: any, input: any) {
  await ensureAiSchema(env);
  return storeFor(env).start(input);
}

export async function finishBeaconProviderAttempt(env: any, attempt: any, outcome: any) {
  await ensureAiSchema(env);
  return storeFor(env).finish(attempt, outcome);
}
