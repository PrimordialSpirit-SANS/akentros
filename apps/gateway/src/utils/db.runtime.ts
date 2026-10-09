import type { AkentrosRuntimeEnv } from "../types.ts";
import type { AkentrosDbAdapter } from "./db.ts";
import { selectAkentrosPgDriver } from "./db.ts";

// Cloudflare Workers PG 模式的 adapter 裝載點:僅由 worker/pgRuntime.ts
// (經 worker.ts 以字面量動態 import)使用。Node 進入點不用本檔——
// 繼續走 db.ts 的 installNodeAkentrosDbAdapter(非字面量 specifier 讓
// DO-SQLite 部署的 bundle 完全不含 pg / @neondatabase/serverless)。
//
// 這裡的動態 import 刻意使用字面量:esbuild 會把兩個 PG adapter 各切成
// 獨立 chunk,Workers bundle 攜帶它們但「執行期用到才載入」——DO-SQLite
// 拓撲(預設)永遠不會載入 PG chunk,冷啟路徑零影響。

/**
 * 依驅動選擇載入 PG adapter 模組(worker PG 模式專用)。
 * db.pg.ts 內部以 HYPERDRIVE 綁定的 connectionString 建立 pg Pool
 * (nodejs_compat 下 pg 走 Hyperdrive 的本地通道);neon 驅動則直接以
 * DATABASE_URL 建 WebSocket 連線(全域 WebSocket,Workers 原生提供)。
 */
export async function loadWorkerPgDbAdapter(env: AkentrosRuntimeEnv): Promise<AkentrosDbAdapter> {
  const driver = selectAkentrosPgDriver(env);
  const mod = driver === "neon" ? await import("./db.pg.serverless.ts") : await import("./db.pg.ts");
  return mod as AkentrosDbAdapter;
}
