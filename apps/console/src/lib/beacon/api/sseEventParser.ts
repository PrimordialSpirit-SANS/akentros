export interface ParsedSseEvent {
  type: string;
  data: string;
}

export class SseEventParser {
  private lineBuffer = "";
  private dataLines: string[] = [];
  private eventType = "message";

  feed(chunk: string, final = false): ParsedSseEvent[] {
    this.lineBuffer += chunk;
    const events: ParsedSseEvent[] = [];
    let lineStart = 0;
    let index = 0;

    while (index < this.lineBuffer.length) {
      const character = this.lineBuffer[index];
      if (character !== "\r" && character !== "\n") {
        index += 1;
        continue;
      }

      if (character === "\r" && index + 1 === this.lineBuffer.length && !final) {
        break;
      }

      const line = this.lineBuffer.slice(lineStart, index);
      const newlineWidth = character === "\r" && this.lineBuffer[index + 1] === "\n" ? 2 : 1;
      this.consumeLine(line, events);
      index += newlineWidth;
      lineStart = index;
    }

    this.lineBuffer = this.lineBuffer.slice(lineStart);

    if (final) {
      // The SSE algorithm discards events that are not terminated by a blank
      // line. Otherwise, a truncated data: [DONE] frame could look successful.
      this.lineBuffer = "";
      this.dataLines = [];
      this.eventType = "message";
    }

    return events;
  }

  private consumeLine(line: string, events: ParsedSseEvent[]) {
    if (line === "") {
      this.dispatch(events);
      return;
    }
    if (line.startsWith(":")) return;

    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "data") {
      this.dataLines.push(value);
    } else if (field === "event") {
      this.eventType = value || "message";
    }
  }

  private dispatch(events: ParsedSseEvent[]) {
    if (this.dataLines.length > 0) {
      events.push({
        type: this.eventType || "message",
        data: this.dataLines.join("\n"),
      });
    }
    this.dataLines = [];
    this.eventType = "message";
  }
}

function throwIfStreamAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("The request was aborted.", "AbortError");
}

export async function* readSseEvents(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<ParsedSseEvent> {
  throwIfStreamAborted(signal);
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseEventParser();
  let reachedEof = false;

  const cancelOnAbort = () => {
    void reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener("abort", cancelOnAbort, { once: true });

  try {
    while (true) {
      throwIfStreamAborted(signal);
      const result = await reader.read();
      throwIfStreamAborted(signal);
      if (result.done) {
        reachedEof = true;
        break;
      }
      const decoded = decoder.decode(result.value, { stream: true });
      for (const event of parser.feed(decoded)) {
        yield event;
      }
    }

    throwIfStreamAborted(signal);
    const tail = decoder.decode();
    for (const event of parser.feed(tail, true)) {
      yield event;
    }
  } finally {
    signal?.removeEventListener("abort", cancelOnAbort);
    if (!reachedEof) {
      await reader.cancel(signal?.reason).catch(() => {});
    }
    reader.releaseLock();
  }
}

export async function consumeSseEventsToDone(
  events: AsyncIterable<ParsedSseEvent>,
  onEvent: (event: ParsedSseEvent, data: string) => void | Promise<void>,
): Promise<boolean> {
  let sawDone = false;

  for await (const event of events) {
    const data = event.data.trim();
    if (data === "[DONE]") {
      sawDone = true;
      continue;
    }
    if (sawDone || !data) continue;
    await onEvent(event, data);
  }

  return sawDone;
}
