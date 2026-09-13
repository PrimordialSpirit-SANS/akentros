import {
  claimConfiguredBeaconProviderCredential,
  createBeaconProviderPoolStore,
} from "../../../../packages/core/src/providerPool.ts";
import { PROVIDER_POOLS, requireProviderPool } from "../../../../packages/core/src/providers.ts";
import { ensureAiSchema } from "./aiSchema.ts";
import { createBeaconQuery } from "./db.ts";

const stores = new Map();
const syncPromises = new Map();

function databaseKey(env: any) {
  return env?.POSTGRES_DB_URL?.trim() || env?.DATABASE_URL?.trim() || "unconfigured-main";
}

async function ready(env: any) {
  await ensureAiSchema(env);
  const key = databaseKey(env);
  if (!stores.has(key)) {
    stores.set(key, createBeaconProviderPoolStore(createBeaconQuery(env)));
  }
  if (!syncPromises.has(key)) {
    syncPromises.set(
      key,
      stores
        .get(key)
        .sync(PROVIDER_POOLS)
        .catch((error: any) => {
          syncPromises.delete(key);
          throw error;
        }),
    );
  }
  await syncPromises.get(key);
  return stores.get(key);
}

export async function claimBeaconProviderCredential(
  env: any,
  route: any,
  requestId: any,
  excludedCredentialIds = [],
) {
  const store = await ready(env);
  const pool = requireProviderPool(route.credential_pool);
  const environment = {
    ...(globalThis.process?.env || {}),
    ...(env || {}),
  };
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

export async function releaseBeaconProviderCredential(env: any, claim: any, outcome: any) {
  const store = await ready(env);
  return store.release({ ...outcome, leaseId: claim.leaseId, selection: claim.pool.selection });
}
