import { createBeaconBillingStore } from "@beacon/core/billing";
import type { BeaconRuntimeEnv } from "../types.ts";
import { ensureAiSchema } from "./aiSchema.ts";
import { createBeaconQuery, dbQuery } from "./db.ts";

const stores = new Map();

function databaseKey(env: BeaconRuntimeEnv) {
  return env?.DATABASE_URL?.trim() || "unconfigured-main";
}

function billingStore(env: BeaconRuntimeEnv) {
  const key = databaseKey(env);
  if (!stores.has(key)) {
    stores.set(key, createBeaconBillingStore(createBeaconQuery(env)));
  }
  return stores.get(key);
}

async function withReadySchema(env: BeaconRuntimeEnv, operation: any, ...args: any[]) {
  await ensureAiSchema(env);
  return billingStore(env)[operation](...args);
}

export const reserveBeaconSpend = (env: BeaconRuntimeEnv, input: any) =>
  withReadySchema(env, "reserve", input);
export const readBeaconBilling = (env: BeaconRuntimeEnv, requestId: any) =>
  withReadySchema(env, "read", requestId);
export const markBeaconDispatched = (env: BeaconRuntimeEnv, requestId: any) =>
  withReadySchema(env, "markDispatched", requestId);
export const settleBeaconSpend = (env: BeaconRuntimeEnv, input: any) => withReadySchema(env, "settle", input);
export const refundBeaconSpend = (env: BeaconRuntimeEnv, input: any) => withReadySchema(env, "refund", input);
export const markBeaconNeedsReconciliation = (env: BeaconRuntimeEnv, input: any) =>
  withReadySchema(env, "markNeedsReconciliation", input);
export const reconcileStaleBeaconReservations = (env: BeaconRuntimeEnv, input: any) =>
  withReadySchema(env, "reconcileStale", input);
export const resolveQuarantinedBeaconReservations = (env: BeaconRuntimeEnv, input: any) =>
  withReadySchema(env, "resolveQuarantined", input);

// ai_rate_limit_buckets 以 (api_key_id, window_start) 為鍵逐請求寫入:
// 分鐘視窗(正數 key id)與免費額度月視窗(負數合成 id)都不會再被讀取,
// 需定期清除,否則表格無限成長並拖慢熱路徑的 ON CONFLICT upsert。
export async function cleanupBeaconRateLimitBuckets(env: BeaconRuntimeEnv) {
  await ensureAiSchema(env);
  await dbQuery(
    env,
    `
    DELETE FROM ai_rate_limit_buckets
    WHERE (api_key_id > 0 AND window_start < ?)
       OR (api_key_id < 0 AND window_start < ?)
  `,
    [
      new Date(Date.now() - 3_600_000).toISOString(),
      new Date(Date.now() - 2 * 30 * 86_400_000).toISOString(),
    ],
  );
  const expiredLeases = await dbQuery(
    env,
    `
    DELETE FROM ai_api_inflight_leases
    WHERE expires_at <= ?
      AND released_at IS NULL
    RETURNING request_id
  `,
    [new Date().toISOString()],
  );
  return { expiredLeases: expiredLeases.rows?.length || 0 };
}
