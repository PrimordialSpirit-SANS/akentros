import type { AkentrosRuntimeEnv } from "../types.ts";
// 定時維護本體:Node 進入點(nodeServer 的 in-process timer)與
// Cloudflare Workers(cron trigger → Durable Object 維護端點)共用。
// 過期/隔離保留單對帳 + rate limit bucket 清理;對帳可重跑、不重複扣退。

import {
  cleanupAkentrosRateLimitBuckets,
  reconcileStaleAkentrosReservations,
  resolveQuarantinedAkentrosReservations,
} from "./aiBilling.ts";

export async function runAkentrosMaintenance(env: AkentrosRuntimeEnv): Promise<{
  staleReservations: number;
  quarantinedReservations: number;
}> {
  const limit = Number(env?.AKENTROS_RECONCILE_LIMIT) || 50;
  await cleanupAkentrosRateLimitBuckets(env);
  const stale = await reconcileStaleAkentrosReservations(env, { limit });
  const quarantined = await resolveQuarantinedAkentrosReservations(env, { limit });
  return { staleReservations: stale.length, quarantinedReservations: quarantined.length };
}
