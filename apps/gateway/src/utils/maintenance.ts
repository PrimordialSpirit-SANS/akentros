import type { BeaconRuntimeEnv } from "../types.ts";
// 定時維護本體:Node 進入點(nodeServer 的 in-process timer)與
// Cloudflare Workers(cron trigger → Durable Object 維護端點)共用。
// 過期/隔離保留單對帳 + rate limit bucket 清理;對帳可重跑、不重複扣退。

import {
  cleanupBeaconRateLimitBuckets,
  reconcileStaleBeaconReservations,
  resolveQuarantinedBeaconReservations,
} from "./aiBilling.ts";

export async function runBeaconMaintenance(env: BeaconRuntimeEnv): Promise<{
  staleReservations: number;
  quarantinedReservations: number;
}> {
  const limit = Number(env?.BEACON_RECONCILE_LIMIT) || 50;
  await cleanupBeaconRateLimitBuckets(env);
  const stale = await reconcileStaleBeaconReservations(env, { limit });
  const quarantined = await resolveQuarantinedBeaconReservations(env, { limit });
  return { staleReservations: stale.length, quarantinedReservations: quarantined.length };
}
