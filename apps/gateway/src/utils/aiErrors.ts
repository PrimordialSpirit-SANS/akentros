import { BeaconError, invalidRequest, openAiErrorBody } from "../../../../packages/core/src/openaiErrors.ts";

export { BeaconError, invalidRequest, openAiErrorBody };

export function sendOpenAiError(c: any, error: any, requestId = "") {
  const safe =
    error instanceof BeaconError
      ? error
      : new BeaconError("Beacon could not complete the request.", { expose: false });
  if (requestId) c.header("X-Request-Id", requestId);
  c.header("Cache-Control", "no-store, no-transform");
  c.header("Pragma", "no-cache");
  c.header("Vary", "Origin, Authorization");
  if (safe.retryAfter) c.header("Retry-After", String(safe.retryAfter));
  return c.json(openAiErrorBody(safe), safe.status);
}
