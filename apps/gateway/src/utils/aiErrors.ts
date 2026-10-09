import { AkentrosError, invalidRequest, openAiErrorBody } from "@akentros/core/openaiErrors";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AkentrosContext } from "../types.ts";
import { logAkentrosEvent } from "./logger.ts";

export { AkentrosError, invalidRequest, openAiErrorBody };

export function sendOpenAiError(c: AkentrosContext, error: unknown, requestId = "") {
  const safe =
    error instanceof AkentrosError
      ? error
      : new AkentrosError("Akentros could not complete the request.", { expose: false });
  // SN-12 fix (M1):非預期例外(如未捕捉的 RangeError、TypeError)原本
  // 對外回 503 但日誌零記錄,營運端不可見。非 AkentrosError 的錯誤一律
  // 記錄;AkentrosError 中 expose=false(內部訊息未透出)的 5xx 也記錄。
  if (!(error instanceof AkentrosError) || (safe.status >= 500 && !safe.expose)) {
    logAkentrosEvent("error", "ai_route_unhandled_error", {
      requestId,
      path: c.req.path,
      method: c.req.method,
      errorName: (error as Error)?.name || typeof error,
      errorMessage: (error as Error)?.message || String(error),
      stack: (error as Error)?.stack ? String((error as Error).stack).slice(0, 2000) : undefined,
    });
  }
  if (requestId) c.header("X-Request-Id", requestId);
  c.header("Cache-Control", "no-store, no-transform");
  c.header("Pragma", "no-cache");
  c.header("Vary", "Origin, Authorization");
  if (safe.retryAfter) c.header("Retry-After", String(safe.retryAfter));
  return c.json(openAiErrorBody(safe), safe.status as ContentfulStatusCode);
}
