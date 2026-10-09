// Cloudflare Workers 進入點。兩種部署模式:
//
// - DO-SQLite(預設):公開 fetch 與 cron(scheduled)都指向單一
//   AkentrosGateway Durable Object(整個 Hono app + SQLite 都在 DO 內)。
// - PostgreSQL(DATABASE_URL 為 postgres:// 或設有 HYPERDRIVE 綁定):
//   Worker 本體直接跑 Hono app + PG adapter(worker/pgRuntime.ts),
//   不經 Durable Object。遷移在每隔離區首次請求前以 advisory lock
//   串行化套用,多隔離區併發由 PG 行鎖/advisory lock 保證。
//
// - 公開流量一律轉發;/internal/maintenance 是 scheduled 事件專屬路徑,
//   Worker 在轉發前擋下,避免外部請求觸發對帳(兩種模式相同)。
// - DO binding(AKENTROS_DO)與 class 遷移見 wrangler.jsonc;singleton 由
//   idFromName 固定,不得分片(計費/限流不變式,見 gatewayDo.ts)。
// - PG 模式經字面量動態 import 載入:esbuild 切成獨立 chunk,DO-SQLite
//   部署永遠不會載入 PG 程式碼,冷啟路徑零影響。

export { AkentrosGateway } from "./worker/gatewayDo.ts";

import type { AkentrosRuntimeEnv } from "./types.ts";
import { isWorkerPgRuntime } from "./utils/db.ts";
import { logAkentrosEvent } from "./utils/logger.ts";

interface AkentrosDoId {
  toString(): string;
}

interface AkentrosDoStub {
  fetch(request: Request): Promise<Response>;
}

interface AkentrosDoNamespace {
  idFromName(name: string): AkentrosDoId;
  get(id: AkentrosDoId): AkentrosDoStub;
}

interface WorkerEnv extends AkentrosRuntimeEnv {
  AKENTROS_DO?: AkentrosDoNamespace;
}

const MAINTENANCE_PATH = "/internal/maintenance";

function akentrosDoStub(env: WorkerEnv): AkentrosDoStub {
  const namespace = env?.AKENTROS_DO;
  if (!namespace) {
    throw new Error("AKENTROS_DO binding is missing: check durable_objects in apps/gateway/wrangler.jsonc.");
  }
  return namespace.get(namespace.idFromName("akentros-gateway"));
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === MAINTENANCE_PATH) {
      return Response.json({ error: "Not found.", code: "not_found" }, { status: 404 });
    }
    if (isWorkerPgRuntime(env)) {
      const { handleWorkerPgFetch } = await import("./worker/pgRuntime.ts");
      return handleWorkerPgFetch(request, env);
    }
    return akentrosDoStub(env).fetch(request);
  },

  async scheduled(
    _event: unknown,
    env: WorkerEnv,
    ctx: { waitUntil(promise: Promise<unknown>): void },
  ): Promise<void> {
    ctx.waitUntil(
      (async () => {
        if (isWorkerPgRuntime(env)) {
          const { runWorkerPgMaintenance } = await import("./worker/pgRuntime.ts");
          await runWorkerPgMaintenance(env);
          return;
        }
        await akentrosDoStub(env)
          .fetch(new Request(`https://akentros-gateway.internal${MAINTENANCE_PATH}`))
          .then((response) => {
            if (!response.ok) {
              logAkentrosEvent("error", "akentros_scheduled_maintenance_failed", {
                httpStatus: response.status,
              });
            }
          });
      })(),
    );
  },
};
