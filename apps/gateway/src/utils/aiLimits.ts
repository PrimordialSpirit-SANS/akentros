import { createAkentrosApiLimitStore } from "@akentros/core/apiLimits";
import type { AkentrosRuntimeEnv } from "../types.ts";
import { ensureAiSchema } from "./aiSchema.ts";
import { createAkentrosQuery } from "./db.ts";

const stores = new Map();

function storeFor(env: AkentrosRuntimeEnv) {
  const key = env?.DATABASE_URL?.trim() || "unconfigured-main";
  if (!stores.has(key)) {
    stores.set(key, createAkentrosApiLimitStore(createAkentrosQuery(env)));
  }
  return stores.get(key);
}

export async function acquireAkentrosApiLimit(env: AkentrosRuntimeEnv, input: any) {
  await ensureAiSchema(env);
  return storeFor(env).acquire(input);
}

export async function releaseAkentrosApiLimit(env: AkentrosRuntimeEnv, requestId: any) {
  await ensureAiSchema(env);
  return storeFor(env).release(requestId);
}
