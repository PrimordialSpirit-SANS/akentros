import type { BeaconAttemptAuditor } from "@beacon/core/providerAttempts";
import { createBeaconProviderAttemptStore } from "@beacon/core/providerAttempts";
import type { BeaconRuntimeEnv } from "../types.ts";
import { ensureAiSchema } from "./aiSchema.ts";
import { createBeaconQuery } from "./db.ts";

const stores = new Map<string, ReturnType<typeof createBeaconProviderAttemptStore>>();

type BeaconAttemptFinish = NonNullable<BeaconAttemptAuditor["finish"]>;

function storeFor(env: BeaconRuntimeEnv) {
  const key = env?.DATABASE_URL?.trim() || "unconfigured-main";
  if (!stores.has(key)) {
    stores.set(key, createBeaconProviderAttemptStore(createBeaconQuery(env)));
  }
  return stores.get(key)!;
}

export async function startBeaconProviderAttempt(
  env: BeaconRuntimeEnv,
  input: Parameters<BeaconAttemptAuditor["start"]>[0],
) {
  await ensureAiSchema(env);
  return storeFor(env).start(input);
}

export async function finishBeaconProviderAttempt(
  env: BeaconRuntimeEnv,
  attempt: unknown,
  outcome: Parameters<BeaconAttemptFinish>[1],
) {
  await ensureAiSchema(env);
  return storeFor(env).finish(attempt, outcome);
}
