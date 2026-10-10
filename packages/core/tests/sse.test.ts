import assert from "node:assert/strict";
import test from "node:test";
import { parseSseStream } from "../src/sse.ts";

function streamFromChunks(chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      }
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>) {
  const events: Array<{ event: string; data: string }> = [];
  for await (const event of parseSseStream(stream)) events.push(event);
  return events;
}

test("parseSseStream yields events from chunked frames with CRLF, comments, and multiline data", async () => {
  const events = await collect(
    streamFromChunks([": keepalive\r\nevent: reasoning\r\nda", "ta: first中文😀\r\ndata: second\r\n\r\n"]),
  );
  assert.deepEqual(events, [{ event: "reasoning", data: "first中文😀\nsecond" }]);
});

test("parseSseStream discards an unterminated frame at EOF", async () => {
  const events = await collect(streamFromChunks(["data: [DONE]"]));
  assert.deepEqual(events, []);
});

// ---------------------------------------------------------------------------
// FUNC-01:串流開頭的 U+FEFF(BOM)必須丟棄;只剝一次,資料中的 U+FEFF 不受影響。
// ---------------------------------------------------------------------------

test("FUNC-01: parseSseStream strips a leading BOM so first-chunk data events survive", async () => {
  const events = await collect(streamFromChunks(['\uFEFFdata: {"ok":true}\n\ndata: [DONE]\n\n']));
  assert.deepEqual(events, [
    { event: "message", data: '{"ok":true}' },
    { event: "message", data: "[DONE]" },
  ]);
});

test("FUNC-01: parseSseStream strips the BOM exactly once; U+FEFF inside data is preserved", async () => {
  const events = await collect(
    streamFromChunks(['\uFEFFdata: {"content":"\uFEFF"}\n\ndata: \uFEFFtail\n\n']),
  );
  assert.deepEqual(events, [
    { event: "message", data: '{"content":"\uFEFF"}' },
    { event: "message", data: "\uFEFFtail" },
  ]);
});

test("FUNC-01: parseSseStream strips a BOM split across chunk boundaries", async () => {
  // BOM 的三位元組(EF BB BF)被任意切在兩個 chunk:首 chunk 解碼為空,
  // 剝離必須等到第一段非空解碼文字出現才生效。
  const events = await collect(
    streamFromChunks([new Uint8Array([0xef]), new Uint8Array([0xbb, 0xbf]), "data: split\n\n"]),
  );
  assert.deepEqual(events, [{ event: "message", data: "split" }]);
});

test("FUNC-01: parseSseStream keeps a U+FEFF arriving after the first decoded text as data", async () => {
  // 首個 chunk 已解出字元後,後續 chunk 開頭的 U+FEFF 不再是 BOM,而是資料;
  // 它讓該行欄位名變成「\uFEFFdata」→ 依 SSE 規格以未知欄位丟棄,事件不產出。
  const events = await collect(streamFromChunks(["data: first\n\n", "\uFEFFdata: second\n\n"]));
  assert.deepEqual(events, [{ event: "message", data: "first" }]);
});

test("FUNC-01: parseSseStream leaves BOM-free streams byte-identical", async () => {
  const events = await collect(streamFromChunks(['event: message\ndata: {"choices":[]}\n\n']));
  assert.deepEqual(events, [{ event: "message", data: '{"choices":[]}' }]);
});
