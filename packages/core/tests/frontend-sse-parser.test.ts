import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(
  new URL("../../../apps/console/src/lib/akentros/api/sseEventParser.ts", import.meta.url),
  "utf8",
);
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const parserModuleUrl = `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`;
const { SseEventParser, consumeSseEventsToDone, readSseEvents } = await import(parserModuleUrl);

test("frontend SSE parser preserves byte-split CRLF, UTF-8, and multiline data", () => {
  const parser = new SseEventParser();
  const decoder = new TextDecoder();
  const bytes = new TextEncoder().encode("event: reasoning\r\ndata: first中文😀\r\ndata: second\r\n\r\n");
  const events: any[] = [];

  for (const byte of bytes) {
    events.push(...parser.feed(decoder.decode(Uint8Array.of(byte), { stream: true })));
  }
  events.push(...parser.feed(decoder.decode(), true));

  assert.deepEqual(events, [{ type: "reasoning", data: "first中文😀\nsecond" }]);
});

test("frontend SSE parser handles comments and multiline data", () => {
  const parser = new SseEventParser();
  assert.deepEqual(parser.feed(": keepalive\nevent: error\ndata: first\ndata: second\n\n"), [
    { type: "error", data: "first\nsecond" },
  ]);
});

test("frontend SSE parser discards pending data at EOF", () => {
  const parser = new SseEventParser();
  assert.deepEqual(parser.feed("data: [DONE]", true), []);
});

test("frontend SSE reader drains after DONE without cancelling the response", async () => {
  let cancelled = false;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode('data: {"choices":[]}\n\ndata: [DONE]\n\ndata: {"ignored":true}\n\n'),
      );
      controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  const received: any[] = [];

  const sawDone = await consumeSseEventsToDone(readSseEvents(stream), (_event: any, data: any) => {
    received.push(data);
  });

  assert.equal(sawDone, true);
  assert.deepEqual(received, ['{"choices":[]}']);
  assert.equal(cancelled, false);
});

test("frontend SSE reader reports AbortError instead of parsing a partial frame", async () => {
  let _cancelled = false;
  const controller = new AbortController();
  const stream = new ReadableStream({
    start(streamController) {
      streamController.enqueue(new TextEncoder().encode('data: {"partial":'));
    },
    cancel() {
      _cancelled = true;
    },
  });
  const iterator = readSseEvents(stream, controller.signal);
  const pending = iterator.next();

  await Promise.resolve();
  controller.abort();

  await assert.rejects(pending, (cause) => cause instanceof DOMException && cause.name === "AbortError");
});
