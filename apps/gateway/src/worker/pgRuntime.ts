import { createApp } from "../app.ts";
import type { AkentrosRuntimeEnv } from "../types.ts";
import { ensureAkentrosSchemaReady, seedAkentrosAdminFromEnv } from "../utils/bootstrap.ts";
import { assertAkentrosConfigBundleAtStartup } from "../utils/configGuard.ts";
import { loadWorkerPgDbAdapter } from "../utils/db.runtime.ts";
import { dbQuery, installAkentrosDbAdapter, withAkentrosTransaction } from "../utils/db.ts";
import { logAkentrosEvent } from "../utils/logger.ts";
import { runAkentrosMaintenance } from "../utils/maintenance.ts";

// Workers 的 PostgreSQL 執行模式(DATABASE_URL 或 HYPERDRIVE 綁定存在時,
// 由 src/worker.ts 分流至此):整個 Hono app 直接跑在 Worker 上,不經
// Durable Object。與 DO-SQLite 拓撲的差異:
// - DB adapter 為 db.pg.ts(Hyperdrive 本地通道 + TCP pg)或
//   db.pg.serverless.ts(Neon 相容 WebSocket),兩者的交易語意
//   (FOR UPDATE 行鎖、pg_advisory_xact_lock)與 Node PG 拓撲完全一致;
//   多隔離區併發的安全性由資料庫層保證,不依賴單寫者序列化。
// - schema 遷移在每個隔離區首次請求前執行,並以交易內 advisory lock
//   串行化——冷啟風暴下多個隔離區同時遷移也不會交錯套用版本。
// - cron(scheduled)直接呼叫 runAkentrosMaintenance,不經 DO 端點。
//
// 單例模型:每個隔離區一份 app + readyPromise(env 物件在隔離區生命週期
// 內為同一引用;置換部署產生新隔離區,自然重建)。

interface AkentrosWorkerPgRuntime {
  app: ReturnType<typeof createApp>;
  env: AkentrosRuntimeEnv;
}

let runtimePromise: Promise<AkentrosWorkerPgRuntime> | null = null;
let runtimeEnv: AkentrosRuntimeEnv | null = null;

function workerPgRuntime(env: AkentrosRuntimeEnv): Promise<AkentrosWorkerPgRuntime> {
  if (!runtimePromise || runtimeEnv !== env) {
    runtimeEnv = env;
    runtimePromise = (async () => {
      installAkentrosDbAdapter(await loadWorkerPgDbAdapter(env));
      // FN-7 fix 對齊:壞設定 fail-fast,拒絕帶病上線。
      assertAkentrosConfigBundleAtStartup();
      const app = createApp(env);
      await ensureWorkerPgSchemaReady(env);
      return { app, env };
    })().catch((error: unknown) => {
      // 失敗不快取:下一個請求重試(與 DO 的 ensureReady 行為一致)。
      runtimePromise = null;
      runtimeEnv = null;
      throw error;
    });
  }
  return runtimePromise;
}

// schema 就緒:與 DO/Node 相同的 ensureAkentrosSchemaReady,外層再包一個
// 交易內的 advisory lock,把「多隔離區同時冷啟 + 未遷移資料庫」的競態
// 串行化(第一個隔離區遷移、其餘等鎖後看到最新版本即返回)。管理員種子
// 的 PBKDF2 是真 I/O await,依 adapter 契約留在交易外;upsert 冪等,
// 併發衝突由下一個請求自然重試。
async function ensureWorkerPgSchemaReady(env: AkentrosRuntimeEnv): Promise<void> {
  await withAkentrosTransaction(env, async () => {
    await dbQuery(env, "SELECT pg_advisory_xact_lock(hashtext('akentros_schema_migration'))");
    await ensureAkentrosSchemaReady(env);
  });
  await seedAkentrosAdminFromEnv(env);
}

/** Workers PG 模式的 fetch 處理(僅處理公開流量;/internal/maintenance 由 worker.ts 擋下)。 */
export async function handleWorkerPgFetch(request: Request, env: AkentrosRuntimeEnv): Promise<Response> {
  const { app } = await workerPgRuntime(env);
  return app.fetch(request, env);
}

/** Workers PG 模式的 cron 維護(等價 DO 拓撲的 scheduled → DO 維護端點)。 */
export async function runWorkerPgMaintenance(env: AkentrosRuntimeEnv): Promise<void> {
  const runtime = await workerPgRuntime(env);
  await runAkentrosMaintenance(runtime.env);
  logAkentrosEvent("info", "akentros_scheduled_maintenance_ok", { topology: "workers-pg" });
}
