import { isAkentrosServiceRestricted } from "@akentros/core/apiKeys";
import type { AkentrosAuthenticatedKey, AkentrosContext, AkentrosNext } from "../types.ts";
import { authenticateAkentrosApiKey } from "../utils/aiApiKeys.ts";
import { AkentrosError, sendOpenAiError } from "../utils/aiErrors.ts";
import { logAkentrosEvent } from "../utils/logger.ts";

function bearerToken(c: AkentrosContext) {
  const authorization = String(c.req.header("authorization") || "");
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match ? match[1].trim() : "";
}

export async function authenticateAkentrosKey(c: AkentrosContext, next: AkentrosNext) {
  let key: AkentrosAuthenticatedKey | null = null;
  try {
    const secret = bearerToken(c);
    if (!secret) {
      return sendOpenAiError(
        c,
        new AkentrosError("A valid Akentros API key is required.", {
          status: 401,
          type: "authentication_error",
          code: "invalid_api_key",
        }),
      );
    }

    key = await authenticateAkentrosApiKey(c.env, secret);
    if (!key) {
      return sendOpenAiError(
        c,
        new AkentrosError("The Akentros API key is invalid, expired, or revoked.", {
          status: 401,
          type: "authentication_error",
          code: "invalid_api_key",
        }),
      );
    }
    if (key.user.is_banned) {
      return sendOpenAiError(
        c,
        new AkentrosError("This account cannot use Akentros.", {
          status: 403,
          type: "permission_error",
          code: "account_banned",
        }),
      );
    }
    if (isAkentrosServiceRestricted(key.user)) {
      return sendOpenAiError(
        c,
        new AkentrosError("Akentros is restricted for this account.", {
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
    logAkentrosEvent("error", "akentros_key_auth_failed", { errorCode: code || "unknown" });
    return sendOpenAiError(
      c,
      new AkentrosError("Akentros authentication is temporarily unavailable.", {
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
  return async (c: AkentrosContext, next: AkentrosNext) => {
    if (!c.get("aiKey")?.scopes?.includes(scope)) {
      return sendOpenAiError(
        c,
        new AkentrosError("The API key does not grant this operation.", {
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

// 任一 scope 即放行。embeddings 端點以 "embeddings" OR "chat:completions" 判定:
// 既有金鑰僅有 chat:completions 時不必換鑰即可用 embeddings(向後相容),
// 新金鑰則由 AKENTROS_DEFAULT_SCOPES 直接取得 embeddings。
export function requireAnyAiScope(...scopes: string[]) {
  return async (c: AkentrosContext, next: AkentrosNext) => {
    const granted = c.get("aiKey")?.scopes || [];
    if (!scopes.some((scope) => granted.includes(scope))) {
      return sendOpenAiError(
        c,
        new AkentrosError("The API key does not grant this operation.", {
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
