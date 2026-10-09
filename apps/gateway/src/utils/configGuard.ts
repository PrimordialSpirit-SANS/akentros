import { BACKEND_PRICING } from "@akentros/core/pricing";
import { PROVIDER_POOLS } from "@akentros/core/providers";
import { assertValidConfigBundle } from "@akentros/core/validation";
import { logAkentrosEvent } from "./logger.ts";

// FN-7 fix:設定檔驗證(HTTPS-only base_url、timeout 上限、價格格式、
// pool/route 交叉引用)原本只在測試執行;繞過 CI 手改設定檔部署時,
// runtime 不會 fail-fast。此 guard 在 gateway 啟動時(兩個拓撲的進入點
// 都呼叫)強制驗證凍結的設定常數,壞設定直接中止啟動,不帶病上線。
export function assertAkentrosConfigBundleAtStartup(
  pricing: Record<string, any> = BACKEND_PRICING,
  pools: Record<string, any> = PROVIDER_POOLS,
) {
  try {
    assertValidConfigBundle(pricing, pools);
  } catch (error: any) {
    logAkentrosEvent("error", "fatal_config_validation_failed", {
      detail: String(error?.message || error),
    });
    throw error;
  }
  return true;
}
