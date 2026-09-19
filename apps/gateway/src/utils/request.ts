// 開發者管理面共用的 JSON body 解析。刻意拋 TypeError:
// aiDeveloper.ts 的 sendKeyError 會把 TypeError 映射成 400 + INVALID_* 代碼。
import { AkentrosError } from "@akentros/core/openaiErrors";
import type { AkentrosContext } from "../types.ts";
import { AKENTROS_SMALL_BODY_MAX_BYTES, readCappedText } from "./bodyLimit.ts";

export async function readJsonObject(
  c: AkentrosContext,
  options: { maxBytes?: number } = {},
): Promise<Record<string, unknown>> {
  // 以串流計數上限讀取,避免 Hono 的 text() 先把整個 body 緩衝進記憶體;
  // 越限轉為 TypeError(400 + REQUEST_BODY_TOO_LARGE),維持管理面既有錯誤契約。
  let raw: string;
  try {
    raw = await readCappedText(c, options.maxBytes ?? AKENTROS_SMALL_BODY_MAX_BYTES);
  } catch (error) {
    if (error instanceof AkentrosError && error.status === 413) {
      const tooLarge: TypeError & { code?: string } = new TypeError("The request body is too large.");
      tooLarge.code = "REQUEST_BODY_TOO_LARGE";
      throw tooLarge;
    }
    throw error;
  }

  const maxBytes = options.maxBytes ?? AKENTROS_SMALL_BODY_MAX_BYTES;
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
