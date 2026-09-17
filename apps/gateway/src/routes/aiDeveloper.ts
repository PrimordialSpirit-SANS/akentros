import { isBeaconServiceRestricted, parseBeaconKeyId } from "@beacon/core/apiKeys";
import { Hono } from "hono";
import { createRateLimit } from "../middleware/rateLimit.ts";
import type { BeaconContext, BeaconEnv, BeaconNext } from "../types.ts";
import {
  createBeaconApiKey,
  ensureBeaconSessionCredential,
  listBeaconApiKeys,
  revokeBeaconApiKey,
  rotateBeaconApiKey,
} from "../utils/aiApiKeys.ts";
import { BeaconError, sendOpenAiError } from "../utils/aiErrors.ts";
import { getBeaconUsageDetail, getBeaconUsageSummary, listBeaconUsageLogs } from "../utils/aiUsage.ts";
import { logBeaconEvent } from "../utils/logger.ts";
import { readJsonObject } from "../utils/request.ts";
import { handleBeaconChatCompletions } from "./aiPublic.ts";
import { authenticateToken } from "./auth.ts";

export const aiDeveloperRoutes = new Hono<BeaconEnv>();
const keyManagementLimiter = createRateLimit({
  keyPrefix: "beacon-key-management",
  windowMs: 15 * 60 * 1000,
  max: 120,
  keyGenerator: (c) => String(c.get("user")?.id || "unknown"),
});

function sendKeyError(c: BeaconContext, error: unknown) {
  const code = (error as { code?: string })?.code;
  if (code === "AI_KEY_LIMIT") {
    return c.json({ error: (error as Error).message, code: "AI_KEY_LIMIT" }, 409);
  }
  if (error instanceof TypeError) {
    return c.json(
      {
        error: (error as Error).message,
        code: code || "INVALID_AI_KEY_CONFIGURATION",
      },
      400,
    );
  }
  if (code === "BEACON_API_KEY_PEPPER_INVALID") {
    return c.json(
      {
        error: "Beacon key management is temporarily unavailable.",
        code: "AI_KEY_CONFIGURATION_UNAVAILABLE",
      },
      503,
    );
  }
  const name = (error as { name?: string })?.name;
  logBeaconEvent("error", "beacon_key_management_failed", { errorCode: code || name || "unknown" });
  return c.json(
    {
      error: "Beacon key management is temporarily unavailable.",
      code: "AI_KEY_MANAGEMENT_UNAVAILABLE",
    },
    503,
  );
}

function sendUsageError(c: BeaconContext, error: unknown) {
  if (error instanceof TypeError) {
    return c.json({ error: (error as Error).message, code: "INVALID_AI_USAGE_QUERY" }, 400);
  }
  const code = (error as { code?: string })?.code;
  const name = (error as { name?: string })?.name;
  logBeaconEvent("error", "beacon_usage_query_failed", { errorCode: code || name || "unknown" });
  return c.json(
    {
      error: "Beacon usage data is temporarily unavailable.",
      code: "AI_USAGE_UNAVAILABLE",
    },
    503,
  );
}

aiDeveloperRoutes.use("*", authenticateToken);
aiDeveloperRoutes.use("*", async (c: BeaconContext, next: BeaconNext) => {
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");
  if (isBeaconServiceRestricted(c.get("user"))) {
    return c.json(
      {
        error: "Access denied: Beacon is restricted for this account.",
        code: "SERVICE_RESTRICTED",
      },
      403,
    );
  }
  await next();
});

// 與公開掛載點(/api/ai/v1/chat/completions)相同,主控台的 chat 端點也必須
// 檢查 scope。session 憑證目前一律授予完整 scope,但若未來出現受限憑證,
// 此處不會靜默放行(防禦縱深)。
aiDeveloperRoutes.post("/chat/completions", async (c: BeaconContext) => {
  const aiKey = await ensureBeaconSessionCredential(c.env, c.get("user")!);
  if (!aiKey?.scopes?.includes("chat:completions")) {
    return sendOpenAiError(
      c,
      new BeaconError("The API key does not grant this operation.", {
        status: 403,
        type: "permission_error",
        code: "insufficient_scope",
      }),
      c.get("aiRequestId"),
    );
  }
  return handleBeaconChatCompletions(c, aiKey);
});

aiDeveloperRoutes.use("*", keyManagementLimiter);

aiDeveloperRoutes.get("/keys", async (c: BeaconContext) => {
  try {
    const keys = await listBeaconApiKeys(c.env, c.get("user")!.id);
    return c.json({ keys });
  } catch (error) {
    return sendKeyError(c, error);
  }
});

aiDeveloperRoutes.post("/keys", async (c: BeaconContext) => {
  try {
    const created = await createBeaconApiKey(c.env, c.get("user")!.id, await readJsonObject(c));
    const { secret, ...key } = created;
    return c.json({ key, api_key: secret }, 201);
  } catch (error) {
    return sendKeyError(c, error);
  }
});

aiDeveloperRoutes.post("/keys/:id/rotate", async (c: BeaconContext) => {
  const keyId = parseBeaconKeyId(c.req.param("id"));
  if (!keyId) {
    return c.json({ error: "Invalid Beacon key ID.", code: "INVALID_AI_KEY_ID" }, 400);
  }
  try {
    const rotated = await rotateBeaconApiKey(c.env, c.get("user")!.id, keyId);
    if (!rotated) {
      return c.json({ error: "Beacon key not found.", code: "AI_KEY_NOT_FOUND" }, 404);
    }
    const { secret, ...key } = rotated;
    return c.json({ key, api_key: secret });
  } catch (error) {
    return sendKeyError(c, error);
  }
});

aiDeveloperRoutes.delete("/keys/:id", async (c: BeaconContext) => {
  const keyId = parseBeaconKeyId(c.req.param("id"));
  if (!keyId) {
    return c.json({ error: "Invalid Beacon key ID.", code: "INVALID_AI_KEY_ID" }, 400);
  }
  try {
    await revokeBeaconApiKey(c.env, c.get("user")!.id, keyId);
    return c.body(null, 204);
  } catch (error) {
    return sendKeyError(c, error);
  }
});

aiDeveloperRoutes.get("/usage/summary", async (c: BeaconContext) => {
  try {
    const usage = await getBeaconUsageSummary(c.env, c.get("user")!.id);
    if (!usage) return c.json({ error: "Account not found.", code: "USER_NOT_FOUND" }, 404);
    return c.json({ usage });
  } catch (error) {
    return sendUsageError(c, error);
  }
});

aiDeveloperRoutes.get("/logs", async (c: BeaconContext) => {
  try {
    return c.json(
      await listBeaconUsageLogs(c.env, c.get("user")!.id, {
        cursor: c.req.query("cursor"),
        limit: c.req.query("limit"),
        model: c.req.query("model"),
        status: c.req.query("status"),
        from: c.req.query("from"),
        to: c.req.query("to"),
        keyId: c.req.query("key_id"),
      }),
    );
  } catch (error) {
    return sendUsageError(c, error);
  }
});

aiDeveloperRoutes.get("/requests/:requestId", async (c: BeaconContext) => {
  try {
    const detail = await getBeaconUsageDetail(c.env, c.get("user")!.id, c.req.param("requestId"));
    if (!detail) {
      return c.json({ error: "Beacon request not found.", code: "AI_REQUEST_NOT_FOUND" }, 404);
    }
    return c.json(detail);
  } catch (error) {
    return sendUsageError(c, error);
  }
});
