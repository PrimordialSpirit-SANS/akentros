export interface ParsedSseEvent {
  type: string;
  data: string;
}

// FN-8 fix:行與事件緩衝上限(對齊 gateway core sse.ts 的 1MB 事件上限)。
// 惡意或被劫持的端點可用無換行的單行無界增長緩衝(實測 60MB 輸入使分頁
// heap 成長 290MB)。超限直接拋錯,由 readSseEvents 的呼叫端當串流錯誤處理。
export const SSE_MAX_LINE_CHARS = 64 * 1024;
export const SSE_MAX_EVENT_CHARS = 1024 * 1024;
const SSE_OVERSIZE_MESSAGE = "The SSE stream exceeded the supported line/event size.";

export class AkentrosSseOversizeError extends Error {
  constructor() {
    super(SSE_OVERSIZE_MESSAGE);
    this.name = "AkentrosSseOversizeError";
  }
}

export class SseEventParser {
  private lineBuffer = "";
  private dataLines: string[] = [];
  private eventChars = 0;
  private eventType = "message";

  feed(chunk: string, final = false): ParsedSseEvent[] {
    this.lineBuffer += chunk;
    if (this.lineBuffer.length > SSE_MAX_LINE_CHARS) {
      // 無換行的單行:繼續餵只會繼續增長;立即中止整個解析。
      throw new AkentrosSseOversizeError();
    }
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
      this.eventChars = 0;
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
      this.eventChars += value.length;
      if (this.eventChars > SSE_MAX_EVENT_CHARS) throw new AkentrosSseOversizeError();
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
    this.eventChars = 0;
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
  // FUNC-01 fix(與 gateway core sse.ts 同步):SSE 規格要求丟棄串流開頭的
  // U+FEFF(BOM)(TextDecoder 預設 ignoreBOM=false,會把 BOM 解進文字)。
  // 不剝離時 BOM 併入首行欄位名(「\uFEFFdata」被當成未知欄位),帶 BOM 的
  // 回應會整批靜默丟失 data 事件。只對「串流解碼出的第一段非空文字」剝一次
  // 首位 BOM(多位元組 BOM 可能跨 chunk 抵達,首個 chunk 或許解碼為空);
  // 之後任何位置的 U+FEFF 都屬於資料,不再修改。
  let awaitingFirstDecodedText = true;
  const stripLeadingBomOnce = (text: string) => {
    if (!awaitingFirstDecodedText || text === "") return text;
    awaitingFirstDecodedText = false;
    return text.replace(/^\uFEFF/, "");
  };

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
      const decoded = stripLeadingBomOnce(decoder.decode(result.value, { stream: true }));
      for (const event of parser.feed(decoded)) {
        yield event;
      }
    }

    throwIfStreamAborted(signal);
    const tail = stripLeadingBomOnce(decoder.decode());
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
