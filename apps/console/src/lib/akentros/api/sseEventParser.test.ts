import { describe, expect, it } from "vitest";
import { consumeSseEventsToDone, type ParsedSseEvent, readSseEvents, SseEventParser } from "./sseEventParser";

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

async function collect(events: AsyncGenerator<ParsedSseEvent>): Promise<ParsedSseEvent[]> {
  const collected: ParsedSseEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe("SseEventParser", () => {
  it("parses a single complete data frame", () => {
    const parser = new SseEventParser();
    const events = parser.feed('data: {"ok":true}\n\n');
    expect(events).toEqual([{ type: "message", data: '{"ok":true}' }]);
  });

  it("buffers frames split across arbitrary chunk boundaries", () => {
    const parser = new SseEventParser();
    expect(parser.feed("data: hel")).toEqual([]);
    expect(parser.feed("lo\n")).toEqual([]);
    expect(parser.feed("\n")).toEqual([{ type: "message", data: "hello" }]);
  });

  it("joins multiple data lines with newline and honors event type", () => {
    const parser = new SseEventParser();
    const events = parser.feed("event: custom\ndata: line1\ndata: line2\n\n");
    expect(events).toEqual([{ type: "custom", data: "line1\nline2" }]);
  });

  it("treats CRLF like LF and ignores comments", () => {
    const parser = new SseEventParser();
    const events = parser.feed(": keep-alive\r\ndata: ok\r\n\r\n");
    expect(events).toEqual([{ type: "message", data: "ok" }]);
  });

  it("does not emit a trailing carriage return line before the next chunk", () => {
    const parser = new SseEventParser();
    expect(parser.feed("data: partial\r")).toEqual([]);
    expect(parser.feed("\ndata: done\n\n")).toEqual([{ type: "message", data: "partial\ndone" }]);
  });

  it("discards an unterminated frame on final flush", () => {
    const parser = new SseEventParser();
    expect(parser.feed("data: [DONE]", true)).toEqual([]);
  });

  it("emits terminated frames during final flush", () => {
    const parser = new SseEventParser();
    expect(parser.feed("data: [DONE]\n\n", true)).toEqual([{ type: "message", data: "[DONE]" }]);
  });

  it("strips only one leading space from field values", () => {
    const parser = new SseEventParser();
    expect(parser.feed("data:  padded\n\n")).toEqual([{ type: "message", data: " padded" }]);
  });

  it("ignores unknown fields", () => {
    const parser = new SseEventParser();
    expect(parser.feed("id: 42\nretry: 100\ndata: kept\n\n")).toEqual([{ type: "message", data: "kept" }]);
  });

  it("does not emit an event for a blank line without data", () => {
    const parser = new SseEventParser();
    expect(parser.feed("\n\n\n")).toEqual([]);
  });
});

describe("readSseEvents", () => {
  it("yields events from a chunked byte stream", async () => {
    const stream = streamFromChunks(["data: a\n\n", "data: b\n\ndata: [DONE]\n\n"]);
    const events = await collect(readSseEvents(stream));
    expect(events.map((event) => event.data)).toEqual(["a", "b", "[DONE]"]);
  });

  it("throws immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const stream = streamFromChunks(["data: a\n\n"]);
    await expect(collect(readSseEvents(stream, controller.signal))).rejects.toThrow("cancelled");
  });

  it("throws a DOMException AbortError when aborted without reason", async () => {
    const controller = new AbortController();
    controller.abort();
    const stream = streamFromChunks(["data: a\n\n"]);
    await expect(collect(readSseEvents(stream, controller.signal))).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});

describe("consumeSseEventsToDone", () => {
  async function* generate(events: ParsedSseEvent[]): AsyncGenerator<ParsedSseEvent> {
    for (const event of events) yield event;
  }

  it("reports when [DONE] was seen and skips data after it", async () => {
    const received: string[] = [];
    const sawDone = await consumeSseEventsToDone(
      generate([
        { type: "message", data: "first" },
        { type: "message", data: "[DONE]" },
        { type: "message", data: "late" },
      ]),
      (_event, data) => {
        received.push(data);
      },
    );
    expect(sawDone).toBe(true);
    expect(received).toEqual(["first"]);
  });

  it("returns false for a truncated stream without [DONE]", async () => {
    const sawDone = await consumeSseEventsToDone(generate([{ type: "message", data: "only" }]), () => {});
    expect(sawDone).toBe(false);
  });

  it("skips empty data payloads", async () => {
    const received: string[] = [];
    await consumeSseEventsToDone(
      generate([
        { type: "message", data: "   " },
        { type: "message", data: "kept" },
      ]),
      (_event, data) => {
        received.push(data);
      },
    );
    expect(received).toEqual(["kept"]);
  });
});
