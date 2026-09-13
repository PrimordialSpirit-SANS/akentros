export interface SseParsedEvent {
  event: string;
  data: string;
}

class SseEventParser {
  lineBuffer: string;
  dataLines: string[];
  event: string;
  eventCharacters: number;
  maxEventCharacters: number;

  constructor(maxEventCharacters = 1024 * 1024) {
    this.lineBuffer = "";
    this.dataLines = [];
    this.event = "message";
    this.eventCharacters = 0;
    this.maxEventCharacters = maxEventCharacters;
  }

  feed(chunk: string, final = false): SseParsedEvent[] {
    this.lineBuffer += chunk;
    const events: SseParsedEvent[] = [];
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
    if (this.lineBuffer.length > this.maxEventCharacters) {
      throw new RangeError("SSE event exceeds the configured size limit.");
    }
    if (final) {
      // The SSE algorithm discards events that are not terminated by a blank
      // line. Otherwise, a truncated data: [DONE] frame could look successful.
      this.lineBuffer = "";
      this.dataLines = [];
      this.event = "message";
      this.eventCharacters = 0;
    }
    return events;
  }

  consumeLine(line: string, events: SseParsedEvent[]) {
    if (line.length > this.maxEventCharacters) {
      throw new RangeError("SSE event exceeds the configured size limit.");
    }
    if (line === "") {
      this.dispatch(events);
      return;
    }
    if (line.startsWith(":")) return;

    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") this.event = value || "message";
    if (field === "data") {
      this.eventCharacters += value.length + 1;
      if (this.eventCharacters > this.maxEventCharacters) {
        throw new RangeError("SSE event exceeds the configured size limit.");
      }
      this.dataLines.push(value);
    }
  }

  dispatch(events: SseParsedEvent[]) {
    if (this.dataLines.length > 0) {
      events.push({
        event: this.event || "message",
        data: this.dataLines.join("\n"),
      });
    }
    this.event = "message";
    this.dataLines = [];
    this.eventCharacters = 0;
  }
}

export async function* parseSseStream(
  stream: ReadableStream<Uint8Array> | null | undefined,
  { maxEventCharacters = 1024 * 1024 }: { maxEventCharacters?: number } = {},
): AsyncGenerator<SseParsedEvent> {
  if (!stream || typeof stream.getReader !== "function") {
    throw new TypeError("parseSseStream requires a ReadableStream.");
  }
  if (!Number.isSafeInteger(maxEventCharacters) || maxEventCharacters < 1024) {
    throw new TypeError("maxEventCharacters must be an integer of at least 1024.");
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const parser = new SseEventParser(maxEventCharacters);
  let reachedEof = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        reachedEof = true;
        break;
      }
      const decoded = decoder.decode(value, { stream: true });
      for (const event of parser.feed(decoded)) yield event;
    }

    const tail = decoder.decode();
    for (const event of parser.feed(tail, true)) yield event;
  } finally {
    if (!reachedEof) {
      await reader.cancel().catch(() => {});
    }
    reader.releaseLock();
  }
}
