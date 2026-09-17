import { Hono } from "hono";
import { createBeaconPublicCorsMiddleware, createCorsMiddleware } from "./middleware/cors.ts";
import { aiDeveloperRoutes } from "./routes/aiDeveloper.ts";
import { aiPublicRoutes } from "./routes/aiPublic.ts";
import { authRoutes, requireCsrfToken } from "./routes/auth.ts";
import type { BeaconContext, BeaconEnv, BeaconNext, BeaconRuntimeEnv } from "./types.ts";
import { sendOpenAiError } from "./utils/aiErrors.ts";
import { dbQuery } from "./utils/db.ts";
import { logBeaconEvent } from "./utils/logger.ts";

// BEACON_ENABLED 是 fail-closed 開關:未明確設為 'true' 時,
// 所有 Beacon 路由(公開推理 + 開發者管理面)一律回 404,不暴露存在。
function beaconEnabled(env: BeaconRuntimeEnv): boolean {
  return (
    String(env?.BEACON_ENABLED || "")
      .trim()
      .toLowerCase() === "true"
  );
}

function createBeaconGate(env: BeaconRuntimeEnv) {
  return async (c: BeaconContext, next: BeaconNext) => {
    if (!beaconEnabled(env)) {
      c.header("Cache-Control", "no-store");
      return c.json(
        {
          error: "Beacon is not enabled on this deployment.",
          code: "route_not_found",
        },
        404,
      );
    }
    await next();
  };
}

export function createApp(env: BeaconRuntimeEnv = {}) {
  const app = new Hono<BeaconEnv>();

  app.use("*", createCorsMiddleware());

  // /healthz 是維運探針,不受 BEACON_ENABLED fail-closed 閘門管轄:
  // 負載平衡器/監控需要它即使服務尚未啟用也能分辨「活著但未就緒」。
  // DB 探測失敗(或 adapter 未安裝)回 503 degraded,成功回 200 ok。
  app.get("/healthz", async (c: BeaconContext) => {
    let database: "ok" | "unavailable" = "unavailable";
    try {
      await dbQuery(c.env, "SELECT 1 AS ok");
      database = "ok";
    } catch {
      // adapter 未安裝(單元測試/進入點未初始化)或資料庫無法連線。
    }
    c.header("Cache-Control", "no-store");
    return c.json(
      {
        status: database === "ok" ? "ok" : "degraded",
        database,
        time: new Date().toISOString(),
      },
      database === "ok" ? 200 : 503,
    );
  });

  app.route("/api/auth", authRoutes);

  app.use("/api/ai/*", createBeaconGate(env));
  app.use("/api/ai/v1/*", createBeaconPublicCorsMiddleware());
  app.use("/api/ai/developer/*", requireCsrfToken);

  app.route("/api/ai/v1", aiPublicRoutes);
  app.route("/api/ai/developer", aiDeveloperRoutes);

  app.notFound((c) => c.json({ error: "Not found.", code: "not_found" }, 404));

  app.onError((error, c) => {
    if (c.req.path.startsWith("/api/ai/")) {
      const requestId = c.get("aiRequestId");
      return sendOpenAiError(c, error, typeof requestId === "string" ? requestId : "");
    }
    logBeaconEvent("error", "gateway_request_failed", {
      method: c.req.method,
      path: c.req.path,
      errorName: (error as Error)?.name || "unknown",
      errorMessage: (error as Error)?.message || "",
    });
    return c.json({ error: "Internal server error.", code: "internal_error" }, 500);
  });

  return app;
}
