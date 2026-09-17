import { isBeaconServiceRestricted } from "@beacon/core/apiKeys";
import type { BeaconAuthenticatedKey, BeaconContext, BeaconNext } from "../types.ts";
import { authenticateBeaconApiKey } from "../utils/aiApiKeys.ts";
import { BeaconError, sendOpenAiError } from "../utils/aiErrors.ts";
import { logBeaconEvent } from "../utils/logger.ts";

function bearerToken(c: BeaconContext) {
  const authorization = String(c.req.header("authorization") || "");
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match ? match[1].trim() : "";
}

export async function authenticateBeaconKey(c: BeaconContext, next: BeaconNext) {
  let key: BeaconAuthenticatedKey | null = null;
  try {
    const secret = bearerToken(c);
    if (!secret) {
      return sendOpenAiError(
        c,
        new BeaconError("A valid Beacon API key is required.", {
          status: 401,
          type: "authentication_error",
          code: "invalid_api_key",
        }),
      );
    }

    key = await authenticateBeaconApiKey(c.env, secret);
    if (!key) {
      return sendOpenAiError(
        c,
        new BeaconError("The Beacon API key is invalid, expired, or revoked.", {
          status: 401,
          type: "authentication_error",
          code: "invalid_api_key",
        }),
      );
    }
    if (key.user.is_banned) {
      return sendOpenAiError(
        c,
        new BeaconError("This account cannot use Beacon.", {
          status: 403,
          type: "permission_error",
          code: "account_banned",
        }),
      );
    }
    if (isBeaconServiceRestricted(key.user)) {
      return sendOpenAiError(
        c,
        new BeaconError("Beacon is restricted for this account.", {
          status: 403,
          type: "permission_error",
          code: "service_restricted",
        }),
      );
    }
  } catch (error) {
    // 僅攔截「金鑰查驗」階段的錯誤。next() 保持在 try 之外,下游 handler
    // 拋出的應用程式錯誤必須交給 app.onError,不可被誤轉成 503 認證失效。
    const code = (error as { code?: string })?.code;
    logBeaconEvent("error", "beacon_key_auth_failed", { errorCode: code || "unknown" });
    return sendOpenAiError(
      c,
      new BeaconError("Beacon authentication is temporarily unavailable.", {
        status: 503,
        type: "service_unavailable",
        code: "authentication_unavailable",
      }),
    );
  }

  c.set("aiKey", key);
  c.set("aiUser", key.user);
  await next();
}

export function requireAiScope(scope: string) {
  return async (c: BeaconContext, next: BeaconNext) => {
    if (!c.get("aiKey")?.scopes?.includes(scope)) {
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
    await next();
  };
}
