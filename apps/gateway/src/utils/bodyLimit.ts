import { AkentrosError } from "@akentros/core/openaiErrors";
import type { AkentrosContext } from "../types.ts";

// 請求體大小上限的統一讀取路徑。Hono 的 c.req.json()/c.req.text() 會把整個
// body 緩衝進記憶體之後才輪到驗證層;在單實例 SQLite 部署下,未認證的
// /api/auth/*(僅 IP 限流)與持金鑰的 /api/ai/v1/*(RPM 上限 6000/分)都能
// 以超大請求體放大記憶體壓力。此處在「讀取過程中」逐塊計數:
// 1. Content-Length 預檢——正常客戶端(OpenAI SDK 等)都會帶,超限直接 413,
//    不啟動串流。
// 2. 串流硬上限——chunked/謊報 Content-Length 的客戶端在累計位元組越限的
//    當下中止讀取,緩衝上限就是 maxBytes。
// 上限值:公開推理面 32MB(模型目錄最大輸入約 2M token,合法請求體可達
// 數 MB,再留 tools 餘量);auth 與管理面 16KB(登入/金鑰承載遠小於此)。
export const AKENTROS_PUBLIC_BODY_MAX_BYTES = 32 * 1024 * 1024;
export const AKENTROS_SMALL_BODY_MAX_BYTES = 16 * 1024;

export async function readCappedText(c: AkentrosContext, maxBytes: number): Promise<string> {
  const declaredLength = Number(c.req.header("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new AkentrosError("The request body is too large.", {
      status: 413,
      type: "invalid_request_error",
      code: "request_too_large",
    });
  }
  const body = c.req.raw.body;
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        throw new AkentrosError("The request body is too large.", {
          status: 413,
          type: "invalid_request_error",
          code: "request_too_large",
        });
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    // 讀到一半拋出時顯式取消,避免連線與上游緩衝繼續累積。
    try {
      await reader.cancel();
    } catch {
      // 串流可能已自行結束。
    }
    reader.releaseLock();
  }
  return text + decoder.decode();
}
