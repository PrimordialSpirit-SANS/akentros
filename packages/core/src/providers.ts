import providerPoolsDocument from "../config/provider-pools.v1.json" with { type: "json" };
import { parseSseStream } from "./sse.ts";

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const FALLBACK_STATUS = new Set([401, 402, 403, 404, 408, 409, 425, 429, 500, 502, 503, 504]);
const MAX_PROVIDER_JSON_BYTES = 4 * 1024 * 1024;

function requiredString(value: unknown, label: string) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new TypeError(`${label} is required.`);
  return normalized;
}

function asNonNegativeInteger(value: unknown, fallback = 0) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

export function normalizeProviderUsage(value: any) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const promptTokens = value.prompt_tokens;
  const completionTokens = value.completion_tokens;
  if (
    !Number.isSafeInteger(promptTokens) ||
    promptTokens < 0 ||
    !Number.isSafeInteger(completionTokens) ||
    completionTokens < 0
  ) {
    return null;
  }
  const totalTokens = promptTokens + completionTokens;
  if (!Number.isSafeInteger(totalTokens)) return null;
  if (
    value.total_tokens !== undefined &&
    value.total_tokens !== null &&
    (!Number.isSafeInteger(value.total_tokens) ||
      value.total_tokens < 0 ||
      value.total_tokens !== totalTokens)
  ) {
    return null;
  }
  // Reasoning is a subset of completion_tokens, never an extra charge.
  const reasoningTokens = value.completion_tokens_details?.reasoning_tokens;
  const reasoningDetails =
    Number.isSafeInteger(reasoningTokens) && reasoningTokens >= 0 && reasoningTokens <= completionTokens
      ? { reasoning_tokens: reasoningTokens as number }
      : null;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    ...(reasoningDetails ? { completion_tokens_details: reasoningDetails } : {}),
  };
}

function retryAfterSeconds(response: Response) {
  const value = response.headers.get("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(3600, Math.ceil(seconds));
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return null;
  return Math.min(3600, Math.max(0, Math.ceil((timestamp - Date.now()) / 1000)));
}

function categoryForStatus(status: number) {
  if (status === 400 || status === 422) return "invalid_request";
  if (status === 401 || status === 403) return "credential_rejected";
  if (status === 402) return "provider_quota_exhausted";
  if (status === 404) return "model_unavailable";
  if (status === 408 || status === 504) return "timeout";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "provider_unavailable";
  return "provider_error";
}

export interface AkentrosProviderErrorOptions {
  provider?: string;
  status?: number;
  category?: string;
  retryable?: boolean;
  fallbackAllowed?: boolean;
  retryAfter?: number | null;
  usageUnknown?: boolean;
  responseStarted?: boolean;
  upstreamRequestId?: string | null;
  cause?: unknown;
}

export class AkentrosProviderError extends Error {
  provider: string;
  status: number;
  code: string;
  category: string;
  retryable: boolean;
  fallbackAllowed: boolean;
  retryAfter: number | null;
  usageUnknown: boolean;
  responseStarted: boolean;
  upstreamRequestId: string | null;

  constructor(
    message: string,
    {
      provider,
      status = 502,
      category = categoryForStatus(status),
      retryable = RETRYABLE_STATUS.has(status),
      fallbackAllowed = FALLBACK_STATUS.has(status),
      retryAfter = null,
      usageUnknown = false,
      responseStarted = false,
      upstreamRequestId = null,
      cause,
    }: AkentrosProviderErrorOptions = {},
  ) {
    super(message, cause ? { cause } : undefined);
    this.name = "AkentrosProviderError";
    this.provider = provider || "unknown";
    this.status = status;
    this.code = category;
    this.category = category;
    this.retryable = retryable;
    this.fallbackAllowed = fallbackAllowed;
    this.retryAfter = retryAfter;
    this.usageUnknown = usageUnknown;
    this.responseStarted = responseStarted;
    this.upstreamRequestId = upstreamRequestId;
  }
}

export const PROVIDER_POOLS: any = providerPoolsDocument;

export function getProviderPool(poolId: string, config: any = PROVIDER_POOLS) {
  const pool = config.pools?.[poolId];
  return pool?.enabled === true ? pool : null;
}

export function requireProviderPool(poolId: string, config: any = PROVIDER_POOLS) {
  const pool = getProviderPool(poolId, config);
  if (!pool) throw new RangeError(`Unknown or disabled Akentros provider pool: ${String(poolId)}`);
  return pool;
}

export function listEnabledCredentials(pool: any) {
  return (pool?.credentials || []).filter((credential: any) => credential.enabled === true);
}

export function resolveProviderCredential(
  pool: any,
  credential: any,
  env: Record<string, string | undefined>,
) {
  if (!pool || !credential || !env)
    throw new TypeError("Provider pool, credential, and environment are required.");
  const secrets: Record<string, string> = {};
  for (const [field, reference] of Object.entries(credential.secret_refs || {}) as Array<[string, string]>) {
    const value = env[reference];
    if (typeof value !== "string" || !value.trim()) {
      const error = new Error(`Akentros provider secret binding ${reference} is not configured.`) as Error & {
        code?: string;
        credentialId?: string;
      };
      error.code = "PROVIDER_SECRET_NOT_CONFIGURED";
      error.credentialId = credential.credential_id;
      throw error;
    }
    secrets[field] = value.trim();
  }
  return Object.freeze({
    credentialId: credential.credential_id,
    provider: pool.provider,
    secrets: Object.freeze(secrets),
  });
}

// Upstream parameter quirks for OpenAI-compatible providers. Most upstreams
// only guarantee the legacy `max_tokens` output-limit field, so Akentros translates
// by default; `max_completion_tokens` is kept for upstreams whose current
// models reject `max_tokens`. Upstreams in NO_STREAM_OPTIONS_PROVIDERS reject
// `stream_options` outright and report usage in their final stream chunk
// instead; missing usage falls back to the conservative estimated settlement.
const MAX_COMPLETION_TOKENS_PROVIDERS = new Set(["openai", "google"]);
const NO_STREAM_OPTIONS_PROVIDERS = new Set(["perplexity", "cohere", "amazon-bedrock"]);

function upstreamBody(body: any, route: any, stream: boolean, options: any = {}) {
  const { model: _publicModel, ...request } = body || {};
  const maxTokensField =
    options.maxTokensField === "max_completion_tokens" ? "max_completion_tokens" : "max_tokens";
  const {
    max_completion_tokens: maxCompletionTokens,
    max_tokens: maxTokens,
    stream_options: streamOptions,
    ...rest
  } = request;
  const outputLimit = maxCompletionTokens ?? maxTokens;
  return {
    ...rest,
    model: route.upstream_model,
    stream,
    ...(outputLimit !== undefined ? { [maxTokensField]: outputLimit } : {}),
    ...(stream && options.streamOptionsUsage !== false
      ? { stream_options: { ...(streamOptions || {}), include_usage: true } }
      : {}),
  };
}

function cloudflareRequestBody(body: any) {
  const stream = Boolean(body?.stream);
  const {
    model: _publicModel,
    stream: _stream,
    stream_options: _streamOptions,
    max_completion_tokens: maxTokens,
    ...request
  } = body || {};
  return { ...request, ...(maxTokens ? { max_tokens: maxTokens } : {}), stream };
}

// Embeddings 上游請求體:僅把公開模型 ID 換成上游模型,其餘欄位(input、
// dimensions、encoding_format)已由 core 的 prepare 驗證過,原樣轉發。
function embeddingsUpstreamBody(body: any, route: any) {
  const { model: _publicModel, ...request } = body || {};
  return { ...request, model: route.upstream_model };
}

function anthropicTextBlocks(content: unknown) {
  if (typeof content === "string" && content) return [{ type: "text", text: content }];
  return [];
}

// Converts the public OpenAI-style chat body to the Anthropic Messages API:
// system/developer messages become the `system` parameter, tool results become
// user `tool_result` blocks, and assistant tool calls become `tool_use` blocks.
function anthropicRequestBody(body: any, route: any, stream: boolean) {
  const source = body || {};
  const systemParts: string[] = [];
  const turns: any[] = [];
  for (const message of Array.isArray(source.messages) ? source.messages : []) {
    if (message?.role === "system" || message?.role === "developer") {
      if (typeof message.content === "string" && message.content) systemParts.push(message.content);
      continue;
    }
    if (message?.role === "tool") {
      turns.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: String(message.tool_call_id || ""),
            content: typeof message.content === "string" ? message.content : "",
          },
        ],
      });
      continue;
    }
    if (message?.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      const blocks: any[] = anthropicTextBlocks(message.content);
      for (const call of message.tool_calls) {
        let input: any = {};
        try {
          input = JSON.parse(call?.function?.arguments || "{}");
        } catch {
          input = {};
        }
        blocks.push({
          type: "tool_use",
          id: typeof call?.id === "string" && call.id ? call.id : `tool_${blocks.length}`,
          name: typeof call?.function?.name === "string" ? call.function.name : "",
          input,
        });
      }
      turns.push({ role: "assistant", content: blocks });
      continue;
    }
    turns.push({
      role: message?.role === "assistant" ? "assistant" : "user",
      content: anthropicTextBlocks(message?.content),
    });
  }
  // Anthropic folds consecutive same-role turns; tool_result blocks must lead
  // their user turn, so text blocks follow them after a fold.
  const messages: any[] = [];
  for (const turn of turns) {
    const previous = messages[messages.length - 1];
    if (previous && previous.role === turn.role) {
      const nextBlocks = Array.isArray(turn.content) ? turn.content : [];
      previous.content =
        turn.role === "user"
          ? [
              ...nextBlocks.filter((block: any) => block.type === "tool_result"),
              ...previous.content,
              ...nextBlocks.filter((block: any) => block.type !== "tool_result"),
            ]
          : [...previous.content, ...nextBlocks];
    } else {
      messages.push(turn);
    }
  }
  const requestedOutput = source.max_completion_tokens ?? source.max_tokens;
  const maxTokens =
    Number.isSafeInteger(Number(requestedOutput)) && Number(requestedOutput) > 0
      ? Number(requestedOutput)
      : 4096;
  const tools = Array.isArray(source.tools)
    ? source.tools.map((tool: any) => ({
        name: String(tool?.function?.name || ""),
        ...(typeof tool?.function?.description === "string" && tool.function.description
          ? { description: tool.function.description }
          : {}),
        input_schema:
          tool?.function?.parameters && typeof tool.function.parameters === "object"
            ? tool.function.parameters
            : { type: "object", properties: {} },
      }))
    : undefined;
  // OpenAI tool_choice → Anthropic Messages API 的映射:
  // - "auto" → 省略(Anthropic 預設即 auto)
  // - "none" → {"type":"none"}:用戶明確要求本次不得呼叫工具。舊版把
  //   "none" 折成 undefined(= auto),上游仍可能呼叫工具,違反請求語意;
  //   Anthropic Messages API 已支援 {"type":"none"}(官方文件:「none
  //   prevents Claude from using any tools」)。tools 照送不省略——交談
  //   歷史含 tool_use/tool_result 區塊時,tools 參數必須存在。
  // - "required" → {"type":"any"}
  // - 指定函式 → {"type":"tool","name":…}
  const toolChoice = !tools
    ? undefined
    : source.tool_choice === undefined || source.tool_choice === "auto"
      ? undefined
      : source.tool_choice === "none"
        ? { type: "none" }
        : source.tool_choice === "required"
          ? { type: "any" }
          : source.tool_choice?.type === "function"
            ? { type: "tool", name: String(source.tool_choice.function?.name || "") }
            : undefined;
  return {
    model: route.upstream_model,
    ...(systemParts.length > 0 ? { system: systemParts.join("\n\n") } : {}),
    messages,
    max_tokens: maxTokens,
    ...(stream ? { stream: true } : {}),
    // Anthropic rejects temperature and top_p together; temperature wins.
    ...(source.temperature !== undefined
      ? { temperature: source.temperature }
      : source.top_p !== undefined
        ? { top_p: source.top_p }
        : {}),
    ...(typeof source.stop === "string" && source.stop
      ? { stop_sequences: [source.stop] }
      : Array.isArray(source.stop) && source.stop.length > 0
        ? { stop_sequences: source.stop }
        : {}),
    ...(tools ? { tools } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
  };
}

function anthropicFinishReason(stopReason: unknown) {
  if (stopReason === "max_tokens") return "length";
  if (stopReason === "tool_use") return "tool_calls";
  if (stopReason === "refusal") return "content_filter";
  return "stop";
}

function normalizeAnthropicCompletion(payload: any, route: any, response: Response) {
  if (payload?.type !== "message" || payload.role !== "assistant" || !Array.isArray(payload.content)) {
    throw new AkentrosProviderError("The upstream provider returned an invalid response.", {
      provider: "anthropic",
      category: "invalid_provider_response",
      fallbackAllowed: false,
      responseStarted: true,
      usageUnknown: true,
      upstreamRequestId: upstreamRequestId(response),
    });
  }
  const text = payload.content
    .filter((block: any) => block?.type === "text")
    .map((block: any) => (typeof block.text === "string" ? block.text : ""))
    .join("");
  const reasoning = payload.content
    .filter((block: any) => block?.type === "thinking")
    .map((block: any) => (typeof block.thinking === "string" ? block.thinking : ""))
    .join("");
  const toolCalls = payload.content
    .filter((block: any) => block?.type === "tool_use")
    .map((block: any, index: number) => ({
      id: typeof block.id === "string" && block.id ? block.id : `tool_${index}`,
      type: "function",
      function: {
        name: typeof block.name === "string" ? block.name : "",
        arguments: JSON.stringify(block.input ?? {}),
      },
    }));
  const inputTokens = Number(payload.usage?.input_tokens);
  const outputTokens = Number(payload.usage?.output_tokens);
  const usage = normalizeProviderUsage({
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
  });
  const message: any = { role: "assistant", content: text, ...(reasoning ? { reasoning } : {}) };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  const normalizedPayload = {
    id: typeof payload.id === "string" && payload.id ? payload.id : `anthropic-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: route.upstream_model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: anthropicFinishReason(payload.stop_reason),
      },
    ],
    ...(usage ? { usage } : {}),
  };
  return {
    payload: normalizedPayload,
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
    usageSource: usage ? "provider" : "estimated",
    upstreamRequestId: upstreamRequestId(response) || normalizedPayload.id,
  };
}

// Converts Anthropic SSE events into the OpenAI chunk vocabulary the public
// streaming pipeline consumes. The final usage-only chunk plus [DONE] mirrors
// what OpenAI-compatible upstreams emit with stream_options.include_usage.
async function* anthropicOpenAiChunks(source: ReadableStream<Uint8Array>, provider: string) {
  let inputTokens = 0;
  let outputTokens = 0;
  let finishReason: string | null = null;
  for await (const event of parseSseStream(source)) {
    if (event.data === "[DONE]") break;
    let payload: any;
    try {
      payload = JSON.parse(event.data);
    } catch {
      continue;
    }
    if (payload?.type === "error" || event.event === "error") {
      throw new AkentrosProviderError("The provider failed after streaming started.", {
        provider,
        status: Number(payload?.error?.code) || 502,
        category: "midstream_provider_error",
        fallbackAllowed: false,
        responseStarted: true,
        usageUnknown: true,
      });
    }
    switch (payload?.type) {
      case "message_start": {
        const startTokens = Number(payload.message?.usage?.input_tokens);
        if (Number.isSafeInteger(startTokens) && startTokens >= 0) inputTokens = startTokens;
        yield { choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] };
        break;
      }
      case "content_block_start": {
        const block = payload.content_block;
        if (block?.type === "tool_use") {
          yield {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: Number.isSafeInteger(Number(payload.index)) ? Number(payload.index) : 0,
                      id: typeof block.id === "string" && block.id ? block.id : "tool_0",
                      type: "function",
                      function: { name: typeof block.name === "string" ? block.name : "", arguments: "" },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          };
        }
        break;
      }
      case "content_block_delta": {
        const delta = payload.delta || {};
        if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text) {
          yield { choices: [{ index: 0, delta: { content: delta.text }, finish_reason: null }] };
        } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking) {
          yield { choices: [{ index: 0, delta: { reasoning: delta.thinking }, finish_reason: null }] };
        } else if (
          delta.type === "input_json_delta" &&
          typeof delta.partial_json === "string" &&
          delta.partial_json
        ) {
          yield {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: Number.isSafeInteger(Number(payload.index)) ? Number(payload.index) : 0,
                      function: { arguments: delta.partial_json },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          };
        }
        break;
      }
      case "message_delta": {
        if (payload.delta?.stop_reason) finishReason = anthropicFinishReason(payload.delta.stop_reason);
        const output = Number(payload.usage?.output_tokens);
        if (Number.isSafeInteger(output) && output >= 0) outputTokens = output;
        yield { choices: [{ index: 0, delta: {}, finish_reason: finishReason }] };
        break;
      }
      default:
        // ping, content_block_stop, and unknown events carry no content.
        break;
    }
  }
  yield {
    choices: [],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
}

function anthropicSseToOpenAiStream(source: ReadableStream<Uint8Array>, provider: string) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of anthropicOpenAiChunks(source, provider)) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (cause) {
        controller.error(cause);
      }
    },
    cancel(reason) {
      return source.cancel(reason);
    },
  });
}

export function buildProviderRequest({ route, pool, credential, body, endpoint = "chat.completions" }: any) {
  const provider = requiredString(route?.provider, "route.provider");
  if (provider !== pool?.provider || provider !== credential?.provider) {
    throw new TypeError("Provider route, pool, and credential do not match.");
  }
  const baseUrl = requiredString(pool.base_url, "pool.base_url").replace(/\/$/, "");
  const apiStyle = requiredString(pool.api_style, "pool.api_style");
  const stream = Boolean(body?.stream);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: stream ? "text/event-stream" : "application/json",
  };
  let url = "";
  let requestBody: any;

  if (apiStyle === "openai-compatible") {
    const apiKey = requiredString(credential.secrets?.api_key, "provider api key");
    headers.authorization = `Bearer ${apiKey}`;
    if (endpoint === "embeddings") {
      url = `${baseUrl}/embeddings`;
      requestBody = embeddingsUpstreamBody(body, route);
    } else {
      url = `${baseUrl}/chat/completions`;
      requestBody = upstreamBody(body, route, stream, {
        maxTokensField: MAX_COMPLETION_TOKENS_PROVIDERS.has(provider)
          ? "max_completion_tokens"
          : "max_tokens",
        streamOptionsUsage: !NO_STREAM_OPTIONS_PROVIDERS.has(provider),
      });
    }
  } else if (apiStyle === "anthropic-messages") {
    if (endpoint === "embeddings") {
      throw new RangeError("Provider does not support the embeddings API.");
    }
    const apiKey = requiredString(credential.secrets?.api_key, "provider api key");
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
    url = `${baseUrl}/messages`;
    requestBody = anthropicRequestBody(body, route, stream);
  } else if (apiStyle === "cloudflare-rest" && provider === "cloudflare-workers-ai") {
    if (endpoint === "embeddings") {
      throw new RangeError("Provider does not support the embeddings API.");
    }
    const apiToken = requiredString(credential.secrets?.api_token, "Cloudflare API token");
    const accountId = requiredString(credential.secrets?.account_id, "Cloudflare account ID");
    headers.authorization = `Bearer ${apiToken}`;
    url = `${baseUrl.replace("{account_id}", encodeURIComponent(accountId))}/${route.upstream_model}`;
    requestBody = cloudflareRequestBody(body);
  } else {
    throw new RangeError(`Unsupported Akentros provider: ${provider}`);
  }

  return {
    url,
    init: {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      redirect: "manual",
    },
    stream,
  };
}

function timeoutSignal(timeoutMs: number, externalSignal?: AbortSignal | null) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromExternal = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abortFromExternal();
  else externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("provider_timeout"));
  }, timeoutMs);
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    dispose() {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", abortFromExternal);
    },
  };
}

function awaitWithSignal(value: unknown, signal?: AbortSignal | null): Promise<any> {
  if (!signal) return Promise.resolve(value);
  if (signal.aborted) return Promise.reject(signal.reason || new Error("provider_aborted"));
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new Error("provider_aborted"));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(value).then(
      (result) => {
        signal.removeEventListener("abort", abort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function transportError(route: any, timeout: any, signal: AbortSignal | null | undefined, cause: unknown) {
  const didTimeout = timeout.didTimeout();
  const externallyAborted = Boolean(signal?.aborted);
  return new AkentrosProviderError(
    didTimeout
      ? "The upstream provider timed out."
      : externallyAborted
        ? "The client disconnected while the provider request was in flight."
        : "The upstream provider could not be reached.",
    {
      provider: route.provider,
      status: didTimeout ? 504 : externallyAborted ? 499 : 502,
      category: didTimeout ? "timeout" : externallyAborted ? "client_disconnected" : "provider_unavailable",
      fallbackAllowed: false,
      retryable: !externallyAborted,
      usageUnknown: true,
      cause,
    },
  );
}

function upstreamRequestId(response: Response) {
  const value =
    response.headers.get("x-request-id") ||
    response.headers.get("request-id") ||
    response.headers.get("x-dashscope-request-id") ||
    response.headers.get("x-generation-id") ||
    response.headers.get("cf-ray") ||
    null;
  if (!value) return null;
  return (
    String(value)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control-character stripping from upstream header values
      .replace(/[\r\n\u0000-\u001f\u007f]/g, "")
      .slice(0, 200) || null
  );
}

async function throwResponseError(provider: string, response: Response) {
  try {
    await response.body?.cancel();
  } catch {
    // The response status and headers remain sufficient for normalization.
  }
  throw new AkentrosProviderError("The upstream provider rejected the request.", {
    provider,
    status: response.status,
    retryAfter: retryAfterSeconds(response),
    upstreamRequestId: upstreamRequestId(response),
  });
}

async function readJsonBody(response: Response): Promise<any> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PROVIDER_JSON_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new RangeError("Provider response body exceeds the configured limit.");
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    throw new SyntaxError("Provider response body is missing.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  let reachedEof = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        reachedEof = true;
        break;
      }
      bytes += value.byteLength;
      if (bytes > MAX_PROVIDER_JSON_BYTES) {
        throw new RangeError("Provider response body exceeds the configured limit.");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    if (!reachedEof) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return JSON.parse(text);
}

// OpenAI embeddings 端點的回應正規化:usage 只含 prompt_tokens/total_tokens
// (無 completion_tokens),輸出 token 恆為 0,計費僅按輸入。embedding 向量
// 本體為數字陣列或 base64 字串(encoding_format=base64),原樣轉發。
function normalizeOpenAiEmbeddings(provider: string, payload: any, response: Response) {
  if (payload?.error) {
    throw new AkentrosProviderError("The upstream provider failed after accepting the request.", {
      provider,
      status: Number(payload.error.code) || 502,
      category: "embedded_provider_error",
      retryable: false,
      fallbackAllowed: false,
      usageUnknown: true,
      responseStarted: true,
      upstreamRequestId: upstreamRequestId(response) || payload?.id || null,
    });
  }
  if (!payload || !Array.isArray(payload.data)) {
    throw new AkentrosProviderError("The upstream provider returned an invalid response.", {
      provider,
      category: "invalid_provider_response",
      fallbackAllowed: false,
      responseStarted: true,
      usageUnknown: true,
      upstreamRequestId: upstreamRequestId(response),
    });
  }
  const promptTokens = Number(payload.usage?.prompt_tokens);
  const usage =
    Number.isSafeInteger(promptTokens) && promptTokens >= 0
      ? normalizeProviderUsage({
          prompt_tokens: promptTokens,
          completion_tokens: 0,
          total_tokens: promptTokens,
        })
      : null;
  const normalizedPayload = { ...payload };
  if (usage) {
    normalizedPayload.usage = {
      prompt_tokens: usage.prompt_tokens,
      total_tokens: usage.total_tokens,
    };
  } else {
    delete normalizedPayload.usage;
  }
  return {
    payload: normalizedPayload,
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: 0,
    usageSource: usage ? "provider" : "estimated",
    upstreamRequestId: upstreamRequestId(response) || payload.id || null,
  };
}

function normalizeOpenAiCompletion(provider: string, payload: any, response: Response) {
  const embeddedError =
    payload?.error ||
    (Array.isArray(payload?.choices)
      ? payload.choices.find((choice: any) => choice?.finish_reason === "error" || choice?.error)?.error
      : null);
  if (embeddedError) {
    throw new AkentrosProviderError("The upstream provider failed after accepting the request.", {
      provider,
      status: Number(embeddedError.code) || 502,
      category: "embedded_provider_error",
      retryable: false,
      fallbackAllowed: false,
      usageUnknown: true,
      responseStarted: true,
      upstreamRequestId: upstreamRequestId(response) || payload?.id || null,
    });
  }
  if (!payload || !Array.isArray(payload.choices)) {
    throw new AkentrosProviderError("The upstream provider returned an invalid response.", {
      provider,
      category: "invalid_provider_response",
      fallbackAllowed: false,
      responseStarted: true,
      usageUnknown: true,
      upstreamRequestId: upstreamRequestId(response),
    });
  }
  const usage = normalizeProviderUsage(payload.usage);
  const normalizedPayload = { ...payload };
  if (usage) normalizedPayload.usage = usage;
  else delete normalizedPayload.usage;
  return {
    payload: normalizedPayload,
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
    usageSource: usage ? "provider" : "estimated",
    upstreamRequestId: upstreamRequestId(response) || payload.id || null,
  };
}

function normalizeCloudflareCompletion(payload: any, route: any, response: Response) {
  if (!payload?.success || !payload.result) {
    throw new AkentrosProviderError("Cloudflare Workers AI returned an invalid response.", {
      provider: "cloudflare-workers-ai",
      category: "invalid_provider_response",
      fallbackAllowed: false,
      responseStarted: true,
      usageUnknown: true,
      upstreamRequestId: upstreamRequestId(response),
    });
  }
  if (Array.isArray(payload.result.choices)) {
    return normalizeOpenAiCompletion("cloudflare-workers-ai", payload.result, response);
  }
  if (typeof payload.result.response !== "string") {
    throw new AkentrosProviderError("Cloudflare Workers AI returned an invalid response.", {
      provider: "cloudflare-workers-ai",
      category: "invalid_provider_response",
      fallbackAllowed: false,
      responseStarted: true,
      usageUnknown: true,
      upstreamRequestId: upstreamRequestId(response),
    });
  }
  const usage = normalizeProviderUsage(payload.result.usage) || normalizeProviderUsage(payload.usage);
  const promptTokens = usage?.prompt_tokens ?? 0;
  const completionTokens = usage?.completion_tokens ?? 0;
  return {
    payload: {
      id: upstreamRequestId(response) || `cf-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: route.upstream_model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: payload.result.response },
          finish_reason: "stop",
        },
      ],
      usage: usage || {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    },
    inputTokens: promptTokens,
    outputTokens: completionTokens,
    usageSource: usage ? "provider" : "estimated",
    upstreamRequestId: upstreamRequestId(response),
  };
}

async function invokeCloudflareBinding({ route, binding, body, signal }: any): Promise<any> {
  const timeout = timeoutSignal(asNonNegativeInteger(route.timeout_ms, 60_000), signal);
  const stream = Boolean(body?.stream);
  let result: any;
  try {
    if (timeout.signal.aborted) {
      throw timeout.signal.reason || new Error("provider_aborted");
    }
    const pending = binding.run(route.upstream_model, cloudflareRequestBody(body), {
      signal: timeout.signal,
    });
    result = await awaitWithSignal(pending, timeout.signal);
  } catch (cause) {
    const error = transportError(route, timeout, signal, cause);
    timeout.dispose();
    throw error;
  }

  if (stream) {
    if (!result || typeof result.getReader !== "function") {
      timeout.dispose();
      throw new AkentrosProviderError("Cloudflare Workers AI did not return an SSE stream.", {
        provider: route.provider,
        category: "invalid_provider_response",
        fallbackAllowed: false,
        responseStarted: true,
        usageUnknown: true,
      });
    }
    let responseBody: any;
    try {
      responseBody = result.pipeThrough(new TransformStream(), { signal: timeout.signal });
    } catch (cause) {
      timeout.dispose();
      throw new AkentrosProviderError("Cloudflare Workers AI returned an invalid stream.", {
        provider: route.provider,
        category: "invalid_provider_response",
        fallbackAllowed: false,
        responseStarted: true,
        usageUnknown: true,
        cause,
      });
    }
    return {
      stream: true,
      response: new Response(responseBody, {
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      }),
      upstreamRequestId: null,
      provider: route.provider,
      didTimeout: timeout.didTimeout,
      wasExternallyAborted: () => Boolean(signal?.aborted),
      dispose: timeout.dispose,
    };
  }

  try {
    const rawRequestId = typeof result?.request_id === "string" ? result.request_id.trim() : "";
    const requestId =
      // biome-ignore lint/suspicious/noControlCharactersInRegex: rejects control characters in upstream request ids
      rawRequestId.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(rawRequestId)
        ? rawRequestId || null
        : null;
    const response = new Response(null);
    const normalized = normalizeCloudflareCompletion({ success: true, result }, route, response);
    return {
      stream: false,
      provider: route.provider,
      ...normalized,
      upstreamRequestId: requestId || normalized.upstreamRequestId,
    };
  } finally {
    timeout.dispose();
  }
}

export async function invokeProviderRoute({
  route,
  pool,
  credential,
  body,
  endpoint = "chat.completions",
  fetchImpl = globalThis.fetch,
  signal,
  cloudflareAiBinding,
}: any): Promise<any> {
  const provider = requiredString(route?.provider, "route.provider");
  if (provider !== pool?.provider || provider !== credential?.provider) {
    throw new TypeError("Provider route, pool, and credential do not match.");
  }
  if (provider === "cloudflare-workers-ai" && typeof cloudflareAiBinding?.run === "function") {
    return invokeCloudflareBinding({
      route,
      binding: cloudflareAiBinding,
      body,
      signal,
    });
  }
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required.");
  const request = buildProviderRequest({ route, pool, credential, body, endpoint });
  const timeout = timeoutSignal(asNonNegativeInteger(route.timeout_ms, 60_000), signal);
  let response: Response;
  try {
    response = await fetchImpl(request.url, { ...request.init, signal: timeout.signal });
  } catch (cause) {
    const error = transportError(route, timeout, signal, cause);
    timeout.dispose();
    throw error;
  }

  if (!response.ok) {
    timeout.dispose();
    await throwResponseError(route.provider, response);
  }
  const requestId = upstreamRequestId(response);
  if (request.stream) {
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("text/event-stream") || !response.body) {
      try {
        await response.body?.cancel();
      } catch {
        // Response metadata is enough to classify the protocol failure.
      }
      timeout.dispose();
      throw new AkentrosProviderError("The upstream provider did not return an SSE stream.", {
        provider: route.provider,
        category: "invalid_provider_response",
        fallbackAllowed: false,
        responseStarted: true,
        usageUnknown: true,
        upstreamRequestId: requestId,
      });
    }
    let responseBody = response.body;
    if (pool.api_style === "anthropic-messages") {
      responseBody = anthropicSseToOpenAiStream(response.body, route.provider);
    }
    return {
      stream: true,
      response:
        responseBody === response.body
          ? response
          : new Response(responseBody, {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
            }),
      upstreamRequestId: requestId,
      provider: route.provider,
      didTimeout: timeout.didTimeout,
      wasExternallyAborted: () => Boolean(signal?.aborted),
      dispose: timeout.dispose,
    };
  }

  let payload: any;
  try {
    payload = await readJsonBody(response);
  } catch (cause) {
    const didTimeout = timeout.didTimeout();
    const externallyAborted = Boolean(signal?.aborted);
    throw new AkentrosProviderError("The upstream provider returned an invalid response.", {
      provider: route.provider,
      status: didTimeout ? 504 : externallyAborted ? 499 : 502,
      category: didTimeout
        ? "timeout"
        : externallyAborted
          ? "client_disconnected"
          : "invalid_provider_response",
      fallbackAllowed: false,
      retryable: !externallyAborted,
      responseStarted: true,
      usageUnknown: true,
      upstreamRequestId: requestId,
      cause,
    });
  } finally {
    timeout.dispose();
  }
  const normalized =
    endpoint === "embeddings"
      ? normalizeOpenAiEmbeddings(route.provider, payload, response)
      : route.provider === "cloudflare-workers-ai"
        ? normalizeCloudflareCompletion(payload, route, response)
        : pool.api_style === "anthropic-messages"
          ? normalizeAnthropicCompletion(payload, route, response)
          : normalizeOpenAiCompletion(route.provider, payload, response);
  return { stream: false, provider: route.provider, ...normalized };
}

export async function invokeWithProviderFallback({
  routes,
  body,
  env,
  fetchImpl = globalThis.fetch,
  signal,
  selectCredential,
  onAttempt,
}: any) {
  if (!Array.isArray(routes) || routes.length === 0) {
    throw new AkentrosProviderError("No Akentros provider route is available.", {
      provider: "none",
      status: 503,
      category: "no_provider_available",
      retryable: true,
      fallbackAllowed: false,
    });
  }
  let lastError: AkentrosProviderError | undefined;
  for (const route of routes) {
    const pool = requireProviderPool(route.credential_pool);
    const configured =
      typeof selectCredential === "function"
        ? await selectCredential({ route, pool })
        : listEnabledCredentials(pool)[0];
    if (!configured) continue;
    let credential: Awaited<ReturnType<typeof selectCredential>>;
    try {
      credential = configured.secrets ? configured : resolveProviderCredential(pool, configured, env);
      const result = await invokeProviderRoute({ route, pool, credential, body, fetchImpl, signal });
      await onAttempt?.({ route, credentialId: credential.credentialId, outcome: "succeeded" });
      return { ...result, route, credentialId: credential.credentialId };
    } catch (error) {
      lastError =
        error instanceof AkentrosProviderError
          ? error
          : new AkentrosProviderError("The provider credential is unavailable.", {
              provider: route.provider,
              status: 503,
              category: (error as any)?.code || "provider_configuration_error",
              fallbackAllowed: true,
              cause: error,
            });
      await onAttempt?.({
        route,
        credentialId: credential?.credentialId || configured.credential_id || null,
        outcome: "failed",
        error: lastError,
      });
      if (!lastError.fallbackAllowed || lastError.responseStarted) throw lastError;
    }
  }
  throw (
    lastError ||
    new AkentrosProviderError("No configured provider credential is available.", {
      provider: "none",
      status: 503,
      category: "no_provider_available",
      retryable: true,
      fallbackAllowed: false,
    })
  );
}
