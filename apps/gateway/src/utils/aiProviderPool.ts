import type { AkentrosCredentialClaim } from "@akentros/core/providerPool";
import {
  claimConfiguredAkentrosProviderCredential,
  createAkentrosProviderPoolStore,
} from "@akentros/core/providerPool";
import { PROVIDER_POOLS, requireProviderPool } from "@akentros/core/providers";
import type { AkentrosRuntimeEnv } from "../types.ts";
import { ensureAiSchema } from "./aiSchema.ts";
import { createAkentrosQuery } from "./db.ts";

const stores = new Map<string, ReturnType<typeof createAkentrosProviderPoolStore>>();
const syncPromises = new Map<string, Promise<unknown>>();

function databaseKey(env: AkentrosRuntimeEnv) {
  return env?.DATABASE_URL?.trim() || "unconfigured-main";
}

async function ready(env: AkentrosRuntimeEnv) {
  await ensureAiSchema(env);
  const key = databaseKey(env);
  if (!stores.has(key)) {
    stores.set(key, createAkentrosProviderPoolStore(createAkentrosQuery(env)));
  }
  if (!syncPromises.has(key)) {
    syncPromises.set(
      key,
      stores
        .get(key)!
        .sync(PROVIDER_POOLS)
        .catch((error: any) => {
          syncPromises.delete(key);
          throw error;
        }),
    );
  }
  await syncPromises.get(key);
  return stores.get(key)!;
}

export async function claimAkentrosProviderCredential(
  env: AkentrosRuntimeEnv,
  route: { credential_pool: string; timeout_ms?: number },
  requestId: string,
  excludedCredentialIds: string[] = [],
): Promise<AkentrosCredentialClaim | null> {
  const store = await ready(env);
  const pool = requireProviderPool(route.credential_pool);
  const environment: Record<string, string | undefined> = {};
  Object.assign(environment, globalThis.process?.env || {}, env || {});
  return claimConfiguredAkentrosProviderCredential({
    store,
    pool,
    poolId: route.credential_pool,
    requestId,
    environment,
    excludedCredentialIds,
    resolveSecrets: true, // Always resolve secrets from the pool to bypass provider CLI logged-in account
    leaseTtlMs: Math.max(Number(pool.selection.lease_ttl_ms) || 0, (Number(route.timeout_ms) || 0) + 30_000),
  });
}

export async function releaseAkentrosProviderCredential(
  env: AkentrosRuntimeEnv,
  claim: Pick<AkentrosCredentialClaim, "leaseId" | "pool">,
  outcome: unknown,
) {
  const store = await ready(env);
  return store.release({ ...(outcome as any), leaseId: claim.leaseId, selection: claim.pool.selection });
}
