import assert from "node:assert/strict";
import test from "node:test";
import { AkentrosError } from "@akentros/core/openaiErrors";
import { sendOpenAiError } from "../src/utils/aiErrors.ts";

// SN-12 fix (M1):sendOpenAiError 原本不記錄底層錯誤 —— AI 路由的未處理
// 例外(如 RangeError)對外回 503 但日誌零記錄,營運端不可見。修復後
// 非預期例外與 expose=false 的 5xx 都寫 ai_route_unhandled_error 事件。

function captureConsoleError<T>(run: () => T): { lines: string[]; result: T } {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(String(args[0] ?? ""));
  };
  try {
    const result = run();
    return { lines, result };
  } finally {
    console.error = original;
  }
}

test("sendOpenAiError logs unexpected non-Akentros errors (SN-12)", async () => {
  const context = {
    header: () => {},
    req: { path: "/api/ai/v1/chat/completions", method: "POST" },
    json: (body: unknown, status: number) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  } as never;

  const { lines } = captureConsoleError(() =>
    sendOpenAiError(context, new RangeError("Maximum call stack size exceeded"), "req_sn12"),
  );
  const logged = lines.find((line) => line.includes("ai_route_unhandled_error"));
  assert.ok(logged, "expected an ai_route_unhandled_error log line");
  const parsed = JSON.parse(logged);
  assert.equal(parsed.level, "error");
  assert.equal(parsed.requestId, "req_sn12");
  assert.equal(parsed.errorName, "RangeError");
  assert.match(parsed.errorMessage, /Maximum call stack/);

  // expose=false 的 5xx AkentrosError(內部訊息未透出)也要記錄。
  const hidden = new AkentrosError("internal detail", { expose: false } as never);
  const second = captureConsoleError(() => sendOpenAiError(context, hidden, "req_sn12b"));
  assert.ok(
    second.lines.some((line) => line.includes("ai_route_unhandled_error")),
    "internal 5xx must be logged too",
  );

  // 已透出的 4xx(驗證錯誤)不需要日誌,維持高訊號雜訊比。
  const exposed = new AkentrosError("bad input", { expose: true } as never);
  const third = captureConsoleError(() => sendOpenAiError(context, exposed, "req_sn12c"));
  assert.equal(
    third.lines.some((line) => line.includes("ai_route_unhandled_error")),
    false,
    "exposed client errors stay silent",
  );
});
