import type {
  AkentrosBillingMarkNeedsReconciliationInput,
  AkentrosBillingQuarantineOptions,
  AkentrosBillingReconcileOptions,
  AkentrosBillingRefundInput,
  AkentrosBillingReserveInput,
  AkentrosBillingSettleInput,
} from "@akentros/core/billing";
import { createAkentrosBillingStore } from "@akentros/core/billing";
import type { AkentrosRuntimeEnv } from "../types.ts";
import { ensureAiSchema } from "./aiSchema.ts";
import { createAkentrosQuery, dbQuery } from "./db.ts";
import { recordAkentrosSettlement } from "./metrics.ts";

const stores = new Map<string, ReturnType<typeof createAkentrosBillingStore>>();

function databaseKey(env: AkentrosRuntimeEnv) {
  return env?.DATABASE_URL?.trim() || "unconfigured-main";
}

function billingStore(env: AkentrosRuntimeEnv) {
  const key = databaseKey(env);
  if (!stores.has(key)) {
    stores.set(key, createAkentrosBillingStore(createAkentrosQuery(env)));
  }
  return stores.get(key);
}

async function withStore<T>(
  env: AkentrosRuntimeEnv,
  run: (store: ReturnType<typeof createAkentrosBillingStore>) => Promise<T>,
): Promise<T> {
  await ensureAiSchema(env);
  return run(billingStore(env)!);
}

export const reserveAkentrosSpend = (env: AkentrosRuntimeEnv, input: AkentrosBillingReserveInput) =>
  withStore(env, (store) => store.reserve(input));
export const readAkentrosBilling = (env: AkentrosRuntimeEnv, requestId: string) =>
  withStore(env, (store) => store.read(requestId));
export const markAkentrosDispatched = (env: AkentrosRuntimeEnv, requestId: string) =>
  withStore(env, (store) => store.markDispatched(requestId));
// 結算成功後累計 tokens/spend 指標(供 /metrics 輸出)。settle 失敗時拋錯,
// 不會記入——指標只反映實際落帳的金額與用量。
export const settleAkentrosSpend = async (env: AkentrosRuntimeEnv, input: AkentrosBillingSettleInput) => {
  const result = await withStore(env, (store) => store.settle(input));
  recordAkentrosSettlement(input);
  return result;
};
export const refundAkentrosSpend = (env: AkentrosRuntimeEnv, input: AkentrosBillingRefundInput) =>
  withStore(env, (store) => store.refund(input));
export const markAkentrosNeedsReconciliation = (
  env: AkentrosRuntimeEnv,
  input: AkentrosBillingMarkNeedsReconciliationInput,
) => withStore(env, (store) => store.markNeedsReconciliation(input));
export const reconcileStaleAkentrosReservations = (
  env: AkentrosRuntimeEnv,
  input: AkentrosBillingReconcileOptions = {},
) => withStore(env, (store) => store.reconcileStale(input));
export const resolveQuarantinedAkentrosReservations = (
  env: AkentrosRuntimeEnv,
  input: AkentrosBillingQuarantineOptions = {},
) => withStore(env, (store) => store.resolveQuarantined(input));

// ai_rate_limit_buckets 以 (api_key_id, window_start) 為鍵逐請求寫入:
// 分鐘視窗(正數 key id)與免費額度月視窗(負數合成 id)都不會再被讀取,
// 需定期清除,否則表格無限成長並拖慢熱路徑的 ON CONFLICT upsert。
export async function cleanupAkentrosRateLimitBuckets(env: AkentrosRuntimeEnv) {
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
