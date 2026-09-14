// 開發者管理面共用的 JSON body 解析。刻意拋 TypeError:
// aiDeveloper.ts 的 sendKeyError 會把 TypeError 映射成 400 + INVALID_* 代碼。
import type { BeaconContext } from "../types.ts";

const DEFAULT_MAX_BYTES = 16 * 1024;

export async function readJsonObject(
  c: BeaconContext,
  options: { maxBytes?: number } = {},
): Promise<Record<string, unknown>> {
  const raw = await c.req.text();
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  if (raw.length > maxBytes) {
    const error: Error & { code?: string } = new TypeError("The request body is too large.");
    error.code = "REQUEST_BODY_TOO_LARGE";
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    throw new TypeError("The request body is not valid JSON.");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("The request body must be a JSON object.");
  }

  return parsed as Record<string, unknown>;
}
