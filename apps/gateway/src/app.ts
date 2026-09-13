import { Hono } from "hono";
import { createBeaconPublicCorsMiddleware, createCorsMiddleware } from "./middleware/cors.ts";
import { aiDeveloperRoutes } from "./routes/aiDeveloper.ts";
import { aiPublicRoutes } from "./routes/aiPublic.ts";
import { authRoutes, requireCsrfToken } from "./routes/auth.ts";
import { sendOpenAiError } from "./utils/aiErrors.ts";

// BEACON_ENABLED 是 fail-closed 開關:未明確設為 'true' 時,
// 所有 Beacon 路由(公開推理 + 開發者管理面)一律回 404,不暴露存在。
function beaconEnabled(env: any): boolean {
  return (
    String(env?.BEACON_ENABLED || "")
      .trim()
      .toLowerCase() === "true"
  );
}

function createBeaconGate(env: any) {
  return async (c: any, next: any) => {
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

export function createApp(env: any = {}) {
  const app = new Hono();

  app.use("*", createCorsMiddleware());

  app.route("/api/auth", authRoutes);

  app.use("/api/ai/*", createBeaconGate(env));
  app.use("/api/ai/v1/*", createBeaconPublicCorsMiddleware());
  app.use("/api/ai/developer/*", requireCsrfToken);

  app.route("/api/ai/v1", aiPublicRoutes);
  app.route("/api/ai/developer", aiDeveloperRoutes);

  app.notFound((c) => c.json({ error: "Not found.", code: "not_found" }, 404));

  app.onError((error, c) => {
    if (c.req.path.startsWith("/api/ai/")) {
      const requestId = (c as any).get("aiRequestId");
      return sendOpenAiError(c, error, typeof requestId === "string" ? requestId : "");
    }
    console.error(
      "Gateway request failed:",
      (error as Error)?.name || "unknown",
      (error as Error)?.message || "",
    );
    return c.json({ error: "Internal server error.", code: "internal_error" }, 500);
  });

  return app;
}
