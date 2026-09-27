import { apiFetch } from "../../../services/api";
import type {
  AkentrosChatMessage,
  AkentrosChatUsage,
  AkentrosPublicErrorCode,
  AkentrosStreamChunk,
} from "../types";
import { getAkentrosAccountChatCompletionsPath, getAkentrosChatCompletionsUrl } from "./akentrosDeveloperApi";
import {
  hasAkentrosErrorEnvelope,
  normalizeAkentrosError,
  normalizeAkentrosStreamChunk,
} from "./akentrosPublicContract";
import { consumeSseEventsToDone, type ParsedSseEvent, readSseEvents } from "./sseEventParser";

export interface AkentrosStreamDeltaEvent {
  content: string;
  reasoning: string;
  elapsedMs: number;
}

export interface AkentrosStreamMetrics {
  headersLatencyMs: number;
  firstDeltaLatencyMs: number | null;
  firstContentLatencyMs: number | null;
  totalLatencyMs: number;
}

export interface AkentrosStreamResult {
  content: string;
  reasoning: string;
  usage: AkentrosChatUsage | null;
  finishReason: string | null;
  requestId: string | null;
  metrics: AkentrosStreamMetrics;
}

export interface StreamAkentrosChatOptions {
  authMode?: "api-key" | "account";
  apiKey?: string;
  model: string;
  messages: AkentrosChatMessage[];
  maxCompletionTokens: number;
  thinking?: boolean;
  signal?: AbortSignal;
  onDelta?: (event: AkentrosStreamDeltaEvent) => void;
  onUsage?: (usage: AkentrosChatUsage) => void;
}

export class AkentrosStreamError extends Error {
  readonly status: number;
  readonly code: AkentrosPublicErrorCode | null;
  readonly requestId: string | null;

  constructor(
    message: string,
    options: {
      status?: number;
      code?: AkentrosPublicErrorCode | null;
      requestId?: string | null;
    } = {},
  ) {
    super(message);
    this.name = "AkentrosStreamError";
    this.status = options.status ?? 0;
    this.code = options.code ?? null;
    this.requestId = options.requestId ?? null;
  }
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("The request was aborted.", "AbortError");
}

async function httpError(
  response: Response,
  signal?: AbortSignal,
  context: "developer" | "inference" = "inference",
): Promise<AkentrosStreamError> {
  const requestId = response.headers.get("x-request-id");
  let text = "";
  try {
    text = await response.text();
  } catch {
    throwIfAborted(signal);
    // The status code remains available even if the error body is unreadable.
  }
  throwIfAborted(signal);

  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  const error = normalizeAkentrosError(payload, {
    status: response.status,
    context,
  });
  return new AkentrosStreamError(error.message, {
    status: response.status,
    code: error.code,
    requestId,
  });
}

function parseEventPayload(event: ParsedSseEvent, requestId: string | null): AkentrosStreamChunk {
  let payload: unknown;
  try {
    payload = JSON.parse(event.data);
  } catch {
    throw new AkentrosStreamError("Akentros 傳回了無法解析的串流資料。", {
      code: "invalid_stream_payload",
      requestId,
    });
  }

  if (event.type === "error" || hasAkentrosErrorEnvelope(payload)) {
    const error = normalizeAkentrosError(payload, {
      context: "stream",
      fallbackCode: "stream_interrupted",
    });
    throw new AkentrosStreamError(error.message, {
      code: error.code,
      requestId,
    });
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new AkentrosStreamError("Akentros 傳回了不支援的串流資料。", {
      code: "invalid_stream_payload",
      requestId,
    });
  }
  return normalizeAkentrosStreamChunk(payload);
}

export async function streamAkentrosChat(options: StreamAkentrosChatOptions): Promise<AkentrosStreamResult> {
  const authMode = options.authMode || "api-key";
  const apiKey = options.apiKey?.trim() || "";
  if (authMode === "api-key" && !apiKey) {
    throw new AkentrosStreamError("請輸入 API 金鑰。", { code: "invalid_request" });
  }
  if (!options.model) throw new AkentrosStreamError("請選擇模型。", { code: "invalid_request" });
  if (!options.messages.some((message) => message.content.trim())) {
    throw new AkentrosStreamError("請輸入訊息。", { code: "invalid_request" });
  }

  throwIfAborted(options.signal);
  const startedAt = performance.now();
  const requestBody: Record<string, unknown> = {
    model: options.model,
    messages: options.messages,
    stream: true,
    stream_options: { include_usage: true },
    max_completion_tokens: Math.max(1, Math.trunc(options.maxCompletionTokens)),
  };

  let response: Response;
  try {
    const headers: Record<string, string> = {
      Accept: "text/event-stream",
      "Content-Type": "application/json",
    };
    if (authMode === "api-key") headers.Authorization = `Bearer ${apiKey}`;

    const request = authMode === "account" ? apiFetch : fetch;
    const endpoint =
      authMode === "account" ? getAkentrosAccountChatCompletionsPath() : getAkentrosChatCompletionsUrl();
    response = await request(endpoint, {
      method: "POST",
      headers,
      credentials: authMode === "account" ? "include" : "omit",
      body: JSON.stringify(requestBody),
      signal: options.signal,
    });
  } catch {
    throwIfAborted(options.signal);
    const error = normalizeAkentrosError(null, { fallbackCode: "connection_error" });
    throw new AkentrosStreamError(error.message, { code: error.code });
  }

  const headersLatencyMs = performance.now() - startedAt;
  if (!response.ok) {
    throw await httpError(response, options.signal, authMode === "account" ? "developer" : "inference");
  }

  const requestId = response.headers.get("x-request-id");
  const contentType = response.headers.get("content-type")?.toLowerCase() || "";
  if (!response.body || !contentType.includes("text/event-stream")) {
    await response.body?.cancel().catch(() => {});
    throw new AkentrosStreamError("Akentros 未傳回 SSE 串流。", {
      status: response.status,
      code: "invalid_stream_response",
      requestId,
    });
  }

  let content = "";
  let reasoning = "";
  let usage: AkentrosChatUsage | null = null;
  let finishReason: string | null = null;
  let firstDeltaLatencyMs: number | null = null;
  let firstContentLatencyMs: number | null = null;
  let sawDone = false;
  try {
    sawDone = await consumeSseEventsToDone(readSseEvents(response.body, options.signal), (event) => {
      const payload = parseEventPayload(event, requestId);
      if (payload.usage) {
        usage = payload.usage;
        options.onUsage?.(payload.usage);
      }

      for (const choice of payload.choices || []) {
        const delta = choice.delta || {};
        const contentDelta = typeof delta.content === "string" ? delta.content : "";
        const reasoningDelta =
          typeof delta.reasoning === "string"
            ? delta.reasoning
            : typeof delta.reasoning_content === "string"
              ? delta.reasoning_content
              : "";

        if (choice.finish_reason) finishReason = choice.finish_reason;
        if (!contentDelta && !reasoningDelta) continue;

        const elapsedMs = performance.now() - startedAt;
        if (firstDeltaLatencyMs === null) firstDeltaLatencyMs = elapsedMs;
        if (contentDelta && firstContentLatencyMs === null) {
          firstContentLatencyMs = elapsedMs;
        }
        content += contentDelta;
        reasoning += reasoningDelta;
        options.onDelta?.({
          content: contentDelta,
          reasoning: reasoningDelta,
          elapsedMs,
        });
      }
    });
  } catch (cause) {
    throwIfAborted(options.signal);
    if (cause instanceof AkentrosStreamError) throw cause;
    const error = normalizeAkentrosError(null, { fallbackCode: "stream_interrupted" });
    throw new AkentrosStreamError(error.message, {
      code: error.code,
      requestId,
    });
  }

  throwIfAborted(options.signal);
  if (!sawDone) {
    throw new AkentrosStreamError("Akentros 串流在完成前中斷。", {
      code: "stream_truncated",
      requestId,
    });
  }

  return {
    content,
    reasoning,
    usage,
    finishReason,
    requestId,
    metrics: {
      headersLatencyMs,
      firstDeltaLatencyMs,
      firstContentLatencyMs,
      totalLatencyMs: performance.now() - startedAt,
    },
  };
}
