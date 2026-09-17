import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  BeaconProviderError,
  invokeProviderRoute,
  listEnabledCredentials,
  requireProviderPool,
  resolveProviderCredential,
} from "@beacon/core/providers";
import dotenv from "dotenv";
import { listDiagnosticModels } from "../scripts/providerDiagnostic.ts";

// 真實上游煙霧測試(可選):預設 skip,不影響本地/CI 測試迴圈。設定
// BEACON_SMOKE_TEST=1(可另以 BEACON_SMOKE_PROVIDER / BEACON_SMOKE_MODEL
// 縮小範圍)並備妥對應供應商金鑰後,以最小請求驗證「路由啟用、憑證可解析、
// 上游回 200、usage 來源」端到端可用,補上單元/契約測試無法涵蓋的真實
// 上游整合面。與 scripts/providerDiagnostic.ts 的 --live 模式同一套邏輯。

const enabled = String(process.env.BEACON_SMOKE_TEST || "").trim() === "1";
const provider = String(process.env.BEACON_SMOKE_PROVIDER || "cloudflare-workers-ai").trim();
const requestedModel = String(process.env.BEACON_SMOKE_MODEL || "").trim();
const TIMEOUT_MS = 30_000;

test("provider smoke: live completion over an enabled route", {
  skip: enabled ? false : "opt-in: set BEACON_SMOKE_TEST=1 (and provider credentials) to run",
}, async (t) => {
  dotenv.config({
    path: path.join(fileURLToPath(new URL("../", import.meta.url)), ".dev.vars"),
    quiet: true,
  });

  const candidates = listDiagnosticModels(provider);
  if (candidates.length === 0) {
    t.skip(`no enabled routes for provider ${provider}`);
    return;
  }
  const selected = requestedModel
    ? candidates.filter((item) => item.publicModel === requestedModel)
    : candidates;
  if (selected.length === 0) {
    t.skip(`BEACON_SMOKE_MODEL=${requestedModel} has no enabled route for ${provider}`);
    return;
  }

  let invoked = 0;
  let lastOutcome: Record<string, unknown> | null = null;
  for (const candidate of selected) {
    const pool = requireProviderPool(candidate.route.credential_pool);
    const credential = listEnabledCredentials(pool).find((entry: any) =>
      Object.values(entry.secret_refs).every((reference) => process.env[String(reference)]?.trim()),
    );
    if (!credential) {
      lastOutcome = { result: "credential_not_configured", public_model: candidate.publicModel };
      continue;
    }

    let result: any;
    try {
      result = await invokeProviderRoute({
        route: { ...candidate.route, timeout_ms: Math.min(candidate.route.timeout_ms, TIMEOUT_MS) },
        pool,
        credential: resolveProviderCredential(pool, credential, process.env),
        body: {
          model: candidate.publicModel,
          messages: [{ role: "user", content: "Reply with OK." }],
          max_completion_tokens: candidate.route.provider === "qwencloud" ? 512 : 8,
          stream: false,
        },
      });
      assert.equal(result.stream, false, "smoke request must use the JSON protocol");
      invoked += 1;
      console.log(
        JSON.stringify({
          public_model: candidate.publicModel,
          result: "ok",
          usage_source: result.usageSource,
        }),
      );
      return;
    } catch (error) {
      lastOutcome = {
        result: error instanceof BeaconProviderError ? error.category : "smoke_error",
        message: error instanceof Error ? error.message : String(error),
        public_model: candidate.publicModel,
      };
    } finally {
      result?.dispose?.();
    }
  }

  if (invoked === 0) {
    const reasons = selected.length === 1 ? `: ${JSON.stringify(lastOutcome)}` : "";
    assert.fail(`no provider smoke request succeeded for ${provider}${reasons}`);
  }
});
