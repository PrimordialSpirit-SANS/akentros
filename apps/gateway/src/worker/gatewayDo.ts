import { createApp } from "../app.ts";
import type { AkentrosRuntimeEnv } from "../types.ts";
import { ensureAkentrosSchemaReady, seedAkentrosAdminFromEnv } from "../utils/bootstrap.ts";
import { installAkentrosDbAdapter } from "../utils/db.ts";
import { runAkentrosMaintenance } from "../utils/maintenance.ts";
import type { AkentrosDoState } from "./doDb.ts";
import { createDoAkentrosDbAdapter } from "./doDb.ts";

// Akentros gateway 的 Durable Object:整個 Hono app + SQLite(ctx.storage.sql)
// 都在這個單一 instance 內運行。單 instance 是計費與限流不變式的一部分
// (金鑰 RPM/併發、IP 限流依賴單一資料庫 + 程序內序列化),因此 Worker 端
// 固定以 idFromName 指向同一個 instance,不得水平分片。
//
// 首次請求前完成 schema 遷移與管理員種子(等價 Node 的 npm run migrate;
// 遷移冪等,由 akentros_ai_schema_migrations 記錄版本)。

const MAINTENANCE_PATH = "/internal/maintenance";

export class AkentrosGateway {
  private readonly state: AkentrosDoState;
  private readonly env: AkentrosRuntimeEnv;
  // Hono app 只建一次:env 在 DO 生命週期內不變,每請求重建(路由註冊、
  // 中介層組裝)只是配置與 GC 浪費;與 nodeServer.ts 的做法對齊。
  private readonly app: ReturnType<typeof createApp>;
  private readyPromise: Promise<void> | null = null;

  constructor(state: any, env: AkentrosRuntimeEnv) {
    this.state = state as AkentrosDoState;
    this.env = env;
    installAkentrosDbAdapter(createDoAkentrosDbAdapter(this.state));
    this.app = createApp(this.env);
  }

  async fetch(request: Request): Promise<Response> {
    await this.ensureReady();
    const url = new URL(request.url);
    if (url.pathname === MAINTENANCE_PATH) {
      // 僅供 Worker 的 scheduled(cron)事件經 DO binding 直呼;
      // 公開流量由 Worker 進入點擋下,不會轉發此路徑。
      const summary = await runAkentrosMaintenance(this.env);
      return Response.json({ ok: true, maintenance: summary });
    }
    return this.app.fetch(request, this.env);
  }

  private ensureReady(): Promise<void> {
    if (!this.readyPromise) {
      // 刻意不用 blockConcurrencyWhile:它會延遲事件交付,而 bootstrap 內的
      // PBKDF2(crypto.subtle)需要 runtime I/O 完成,包在裡面會死鎖。
      // DO 的事件序列化 + storage op 的 input gate 已保證遷移語句間不交錯。
      this.readyPromise = (async () => {
        await ensureAkentrosSchemaReady(this.env);
        await seedAkentrosAdminFromEnv(this.env);
      })().catch((error) => {
        // 失敗不快取:下一個請求重試(與 readiness fail-closed 行為一致)。
        this.readyPromise = null;
        throw error;
      });
    }
    return this.readyPromise;
  }
}
