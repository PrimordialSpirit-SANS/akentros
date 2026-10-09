import assert from "node:assert/strict";
import test from "node:test";
import { BACKEND_PRICING } from "@akentros/core/pricing";
import { PROVIDER_POOLS } from "@akentros/core/providers";
import { assertAkentrosConfigBundleAtStartup } from "../src/utils/configGuard.ts";

// FN-7 fix:gateway 啟動時(nodeServer.ts 與 Worker DO 建構兩個拓撲)強制
// 驗證凍結的設定常數;此前驗證只在 CI 測試執行,手改設定檔部署時
// runtime 不會 fail-fast。

test("startup config guard accepts the shipped config bundle", () => {
  assert.equal(assertAkentrosConfigBundleAtStartup(), true);
});

test("startup config guard rejects a tampered route timeout beyond the 240s ceiling", () => {
  // FN-5 fix 同場驗證:timeout 上限 300000 -> 240000 後,塞入 300000 的
  // 路由必須在啟動時被擋下,而非帶病上線等待結算 race。
  const tampered = structuredClone(BACKEND_PRICING);
  const firstModel = Object.values(tampered.models)[0] as any;
  firstModel.routes[0].timeout_ms = 300000;
  assert.throws(
    () => assertAkentrosConfigBundleAtStartup(tampered as any, PROVIDER_POOLS),
    (error: any) => /timeout_ms/.test(String(error?.message || error)),
  );
});

test("startup config guard rejects an http provider base_url", () => {
  // HTTPS-only 不變式原本只由 CI 測試把關(F8 core 發現);啟動 guard 補上。
  const tamperedPools = structuredClone(PROVIDER_POOLS) as any;
  const firstPool = Object.values(tamperedPools.pools)[0] as Record<string, unknown>;
  firstPool.base_url = "http://insecure-upstream.example.com/v1";
  assert.throws(
    () => assertAkentrosConfigBundleAtStartup(BACKEND_PRICING, tamperedPools),
    (error: any) => /base_url|https/i.test(String(error?.message || error)),
  );
});
