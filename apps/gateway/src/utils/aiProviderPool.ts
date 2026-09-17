import type { BeaconCredentialClaim } from "@beacon/core/providerPool";
import {
  claimConfiguredBeaconProviderCredential,
  createBeaconProviderPoolStore,
} from "@beacon/core/providerPool";
import { PROVIDER_POOLS, requireProviderPool } from "@beacon/core/providers";
import type { BeaconRuntimeEnv } from "../types.ts";
import { ensureAiSchema } from "./aiSchema.ts";
import { createBeaconQuery } from "./db.ts";

const stores = new Map<string, ReturnType<typeof createBeaconProviderPoolStore>>();
const syncPromises = new Map<string, Promise<unknown>>();

function databaseKey(env: BeaconRuntimeEnv) {
  return env?.DATABASE_URL?.trim() || "unconfigured-main";
}

async function ready(env: BeaconRuntimeEnv) {
  await ensureAiSchema(env);
  const key = databaseKey(env);
  if (!stores.has(key)) {
    stores.set(key, createBeaconProviderPoolStore(createBeaconQuery(env)));
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

export async function claimBeaconProviderCredential(
  env: BeaconRuntimeEnv,
  route: { credential_pool: string; timeout_ms?: number },
  requestId: string,
  excludedCredentialIds: string[] = [],
): Promise<BeaconCredentialClaim | null> {
  const store = await ready(env);
  const pool = requireProviderPool(route.credential_pool);
  const environment: Record<string, string | undefined> = {};
  Object.assign(environment, globalThis.process?.env || {}, env || {});
  return claimConfiguredBeaconProviderCredential({
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

export async function releaseBeaconProviderCredential(
  env: BeaconRuntimeEnv,
  claim: Pick<BeaconCredentialClaim, "leaseId" | "pool">,
  outcome: unknown,
) {
  const store = await ready(env);
  return store.release({ ...(outcome as any), leaseId: claim.leaseId, selection: claim.pool.selection });
}
