import type { AkentrosAttemptAuditor } from "@akentros/core/providerAttempts";
import { createAkentrosProviderAttemptStore } from "@akentros/core/providerAttempts";
import type { AkentrosRuntimeEnv } from "../types.ts";
import { ensureAiSchema } from "./aiSchema.ts";
import { createAkentrosQuery } from "./db.ts";

const stores = new Map<string, ReturnType<typeof createAkentrosProviderAttemptStore>>();

type AkentrosAttemptFinish = NonNullable<AkentrosAttemptAuditor["finish"]>;

function storeFor(env: AkentrosRuntimeEnv) {
  const key = env?.DATABASE_URL?.trim() || "unconfigured-main";
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
