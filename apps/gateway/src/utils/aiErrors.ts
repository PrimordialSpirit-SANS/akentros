import { BeaconError, invalidRequest, openAiErrorBody } from "@beacon/core/openaiErrors";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { BeaconContext } from "../types.ts";

export { BeaconError, invalidRequest, openAiErrorBody };

export function sendOpenAiError(c: BeaconContext, error: unknown, requestId = "") {
  const safe =
    error instanceof BeaconError
      ? error
      : new BeaconError("Beacon could not complete the request.", { expose: false });
  if (requestId) c.header("X-Request-Id", requestId);
  c.header("Cache-Control", "no-store, no-transform");
  c.header("Pragma", "no-cache");
  c.header("Vary", "Origin, Authorization");
  if (safe.retryAfter) c.header("Retry-After", String(safe.retryAfter));
  return c.json(openAiErrorBody(safe), safe.status as ContentfulStatusCode);
}
