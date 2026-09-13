import { createApp } from "../app.ts";
import { ensureBeaconSchemaReady, seedBeaconAdminFromEnv } from "../utils/bootstrap.ts";
import { installBeaconDbAdapter } from "../utils/db.ts";
import { runBeaconMaintenance } from "../utils/maintenance.ts";
import type { BeaconDoState } from "./doDb.ts";
import { createDoBeaconDbAdapter } from "./doDb.ts";

// Beacon gateway 的 Durable Object:整個 Hono app + SQLite(ctx.storage.sql)
// 都在這個單一 instance 內運行。單 instance 是計費與限流不變式的一部分
// (金鑰 RPM/併發、IP 限流依賴單一資料庫 + 程序內序列化),因此 Worker 端
// 固定以 idFromName 指向同一個 instance,不得水平分片。
//
// 首次請求前完成 schema 遷移與管理員種子(等價 Node 的 npm run migrate;
// 遷移冪等,由 beacon_ai_schema_migrations 記錄版本)。

const MAINTENANCE_PATH = "/internal/maintenance";

export class BeaconGateway {
  private readonly state: BeaconDoState;
  private readonly env: any;
  private readyPromise: Promise<void> | null = null;

  constructor(state: any, env: any) {
    this.state = state as BeaconDoState;
    this.env = env;
    installBeaconDbAdapter(createDoBeaconDbAdapter(this.state));
  }

  async fetch(request: Request): Promise<Response> {
    await this.ensureReady();
    const url = new URL(request.url);
    if (url.pathname === MAINTENANCE_PATH) {
      // 僅供 Worker 的 scheduled(cron)事件經 DO binding 直呼;
      // 公開流量由 Worker 進入點擋下,不會轉發此路徑。
      const summary = await runBeaconMaintenance(this.env);
      return Response.json({ ok: true, maintenance: summary });
    }
    return createApp(this.env).fetch(request, this.env);
  }

  private ensureReady(): Promise<void> {
    if (!this.readyPromise) {
      // 刻意不用 blockConcurrencyWhile:它會延遲事件交付,而 bootstrap 內的
      // PBKDF2(crypto.subtle)需要 runtime I/O 完成,包在裡面會死鎖。
      // DO 的事件序列化 + storage op 的 input gate 已保證遷移語句間不交錯。
      this.readyPromise = (async () => {
        await ensureBeaconSchemaReady(this.env);
        await seedBeaconAdminFromEnv(this.env);
      })().catch((error) => {
        // 失敗不快取:下一個請求重試(與 readiness fail-closed 行為一致)。
        this.readyPromise = null;
        throw error;
      });
    }
    return this.readyPromise;
  }
}
