import { createBeaconRequestFingerprint } from "./billing.ts";
import { BeaconError, invalidRequest } from "./openaiErrors.ts";
import {
  BACKEND_PRICING,
  calculateActualCostMicros,
  calculateReservationCostMicros,
  createBillingSnapshot,
  estimateInputTokens,
  listCandidateRoutes,
  listEnabledModels,
  requireModelPricing,
} from "./pricing.ts";
import { BeaconProviderError, invokeProviderRoute, normalizeProviderUsage } from "./providers.ts";
import { parseSseStream } from "./sse.ts";

const MESSAGE_ROLES = new Set(["system", "developer", "user", "assistant", "tool"]);
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,200}$/;
const PUBLIC_REQUEST_FIELDS = new Set([
  "model",
  "messages",
  "stream",
  "stream_options",
  "max_completion_tokens",
  "max_tokens",
  "temperature",
  "top_p",
  "stop",
  "presence_penalty",
  "frequency_penalty",
  "seed",
  "n",
  "chat_template_kwargs",
  "tools",
  "tool_choice",
  "response_format",
]);
const PUBLIC_FINISH_REASONS = new Set(["stop", "length", "content_filter", "tool_calls"]);
const PUBLIC_BEACON_ERROR_CODES = new Set([
  "invalid_request",
  "invalid_json",
  "unsupported_parameter",
  "unsupported_feature",
  "invalid_api_key",
  "account_banned",
  "service_restricted",
  "insufficient_scope",
  "model_not_found",
  "model_not_allowed",
  "context_length_exceeded",
  "spend_limit_exceeded",
  "insufficient_balance",
  "free_quota_exceeded",
  "rate_limit_exceeded",
  "max_in_flight_exceeded",
  "idempotency_conflict",
  "idempotent_request_in_progress",
  "idempotent_request_replayed",
  "request_cancelled",
  "route_not_found",
  "service_unavailable",
]);
const MAX_PROVIDER_ATTEMPTS = 8;

function requestId() {
  return `req_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
}

function isObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function integer(
  value: unknown,
  label: string,
  { minimum = 0, maximum = Number.MAX_SAFE_INTEGER }: { minimum?: number; maximum?: number } = {},
) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw invalidRequest(`${label} must be an integer from ${minimum} through ${maximum}.`, label);
  }
  return parsed;
}

function finiteNumber(
  value: unknown,
  label: string,
  { minimum, maximum }: { minimum: number; maximum: number },
) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw invalidRequest(`${label} must be a number from ${minimum} through ${maximum}.`, label);
  }
  return parsed;
}

function validateStop(value: unknown) {
  const values = typeof value === "string" ? [value] : value;
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    values.length > 4 ||
    values.some((item: unknown) => typeof item !== "string" || item.length === 0 || item.length > 1000)
  ) {
    throw invalidRequest("stop must be a string or an array of 1-4 non-empty strings.", "stop");
  }
  return typeof value === "string" ? value : [...values];
}

function validateStreamOptions(value: unknown, stream: boolean) {
  if (value === undefined) return stream ? { include_usage: true } : undefined;
  if (
    !stream ||
    !isObject(value) ||
    Object.keys(value).some((key) => key !== "include_usage") ||
    (value.include_usage !== undefined && value.include_usage !== true)
  ) {
    throw invalidRequest(
      "stream_options only supports include_usage for streaming requests.",
      "stream_options",
      "unsupported_parameter",
    );
  }
  return { include_usage: true };
}

function validateChatTemplateKwargs(value: unknown, _modelId: string) {
  if (value === undefined) return undefined;
  throw invalidRequest(
    "chat_template_kwargs only supports a boolean thinking option for this Beacon model.",
    "chat_template_kwargs",
    "unsupported_parameter",
  );
}

function validateFunctionCall(
  value: unknown,
  label: string,
  { requireId = false }: { requireId?: boolean } = {},
): any {
  if (!isObject(value)) throw invalidRequest(`${label} must be an object.`, label);
  const allowed = requireId ? ["id", "type", "function"] : ["name", "arguments"];
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw invalidRequest(`${label} contains an unsupported field.`, label);
  if (requireId) {
    if (typeof value.id !== "string" || value.id.length < 1 || value.id.length > 200)
      throw invalidRequest(`${label}.id must contain 1-200 characters.`, `${label}.id`);
    if (value.type !== "function") throw invalidRequest(`${label}.type must be function.`, `${label}.type`);
    return {
      id: value.id,
      type: "function",
      function: validateFunctionCall(value.function, `${label}.function`),
    };
  }
  if (typeof value.name !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(value.name))
    throw invalidRequest(`${label}.name must be a valid function name.`, `${label}.name`);
  if (typeof value.arguments !== "string")
    throw invalidRequest(`${label}.arguments must be a JSON string.`, `${label}.arguments`);
  return { name: value.name, arguments: value.arguments };
}

function validateMessages(messages: unknown): any[] {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 256) {
    throw invalidRequest("messages must contain between 1 and 256 items.", "messages");
  }
  return messages.map((message: any, index: number) => {
    if (!isObject(message) || !MESSAGE_ROLES.has(message.role)) {
      throw invalidRequest("Each message must have a supported role.", `messages.${index}.role`);
    }
    const label = `messages.${index}`;
    const hasToolCalls =
      message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
    if (message.role === "tool") {
      if (
        typeof message.tool_call_id !== "string" ||
        message.tool_call_id.length < 1 ||
        message.tool_call_id.length > 200
      )
        throw invalidRequest("Tool messages require a valid tool_call_id.", `${label}.tool_call_id`);
    } else if (message.tool_call_id !== undefined)
      throw invalidRequest("tool_call_id is only valid for tool messages.", `${label}.tool_call_id`);
    if ((typeof message.content !== "string" || message.content.length === 0) && !hasToolCalls)
      throw invalidRequest(
        "Messages require non-empty text content or assistant tool calls.",
        `${label}.content`,
      );
    if (typeof message.content === "string" && message.content.length > 100_000) {
      throw invalidRequest("A message exceeds the supported text length.", `messages.${index}.content`);
    }
    if (message.tool_calls !== undefined && message.role !== "assistant")
      throw invalidRequest("tool_calls is only valid for assistant messages.", `${label}.tool_calls`);
    const toolCalls = hasToolCalls
      ? message.tool_calls.map((call: any, callIndex: number) =>
          validateFunctionCall(call, `${label}.tool_calls.${callIndex}`, { requireId: true }),
        )
      : undefined;
    return {
      role: message.role,
      content: hasToolCalls && message.content === undefined ? null : message.content,
      ...(toolCalls ? { tool_calls: toolCalls } : {}),
      ...(message.role === "tool" ? { tool_call_id: message.tool_call_id } : {}),
    };
  });
}

function validateTools(value: unknown): any[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 128)
    throw invalidRequest("tools must contain between 1 and 128 function definitions.", "tools");
  const names = new Set<string>();
  return value.map((tool: any, index: number) => {
    const label = `tools.${index}`;
    if (!isObject(tool) || tool.type !== "function" || !isObject(tool.function))
      throw invalidRequest("Each tool must be a function definition.", label);
    const fn = tool.function;
    if (typeof fn.name !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(fn.name))
      throw invalidRequest(
        "Tool names must contain 1-64 letters, numbers, underscores, or hyphens.",
        `${label}.function.name`,
      );
    if (names.has(fn.name)) throw invalidRequest("Tool names must be unique.", `${label}.function.name`);
    names.add(fn.name);
    if (fn.description !== undefined && (typeof fn.description !== "string" || fn.description.length > 4096))
      throw invalidRequest(
        "Tool descriptions must not exceed 4096 characters.",
        `${label}.function.description`,
      );
    if (!isObject(fn.parameters))
      throw invalidRequest("Tool parameters must be a JSON Schema object.", `${label}.function.parameters`);
    return {
      type: "function",
      function: {
        name: fn.name,
        ...(fn.description !== undefined ? { description: fn.description } : {}),
        parameters: fn.parameters,
      },
    };
  });
}

function validateToolChoice(value: any, tools: any[]) {
  if (value === undefined) return undefined;
  if (["none", "auto", "required"].includes(value)) return value;
  if (
    !isObject(value) ||
    value.type !== "function" ||
    !isObject(value.function) ||
    typeof value.function.name !== "string"
  )
    throw invalidRequest("tool_choice must be none, auto, required, or a named function.", "tool_choice");
  if (!tools.some((tool) => tool.function.name === value.function.name))
    throw invalidRequest("tool_choice references a function not present in tools.", "tool_choice");
  return { type: "function", function: { name: value.function.name } };
}

function replayError(reserved: { status: string; requestId: string }) {
  const inProgress = reserved.status === "dispatched" || reserved.status === "reserved";
  const error = new BeaconError(
    inProgress
      ? "A request with this Idempotency-Key is already in progress."
      : "This Idempotency-Key has already completed and will not be executed again.",
    {
      status: 409,
      type: "invalid_request_error",
      code: inProgress ? "idempotent_request_in_progress" : "idempotent_request_replayed",
      param: "Idempotency-Key",
    },
  );
  error.requestId = reserved.requestId;
  return error;
}

export function listPublicBeaconModels(config = BACKEND_PRICING) {
  const created = Math.floor(Date.parse(config.published_at) / 1000);
  return {
    object: "list",
    data: listEnabledModels(config).map((model) => ({
      id: model.id,
      object: "model",
      created,
      owned_by: model.owned_by,
    })),
  };
}

export async function prepareBeaconChatRequest({
  body,
  aiKey,
  idempotencyKey = null,
}: {
  body: any;
  aiKey: any;
  idempotencyKey?: string | null;
}) {
  if (!isObject(body)) throw invalidRequest("The request body must be a JSON object.");
  const unsupportedField = Object.keys(body).find((field) => !PUBLIC_REQUEST_FIELDS.has(field));
  if (unsupportedField) {
    throw invalidRequest(
      `The parameter '${unsupportedField}' is not supported by Beacon.`,
      unsupportedField,
      "unsupported_parameter",
    );
  }
  const modelId = typeof body.model === "string" ? body.model.trim() : "";
  let model: ReturnType<typeof requireModelPricing>;
  try {
    model = requireModelPricing(modelId);
  } catch {
    throw new BeaconError(`The model '${modelId || "unknown"}' does not exist or is disabled.`, {
      status: 404,
      type: "invalid_request_error",
      code: "model_not_found",
      param: "model",
    });
  }
  if (
    Array.isArray(aiKey?.model_allowlist) &&
    aiKey.model_allowlist.length > 0 &&
    !aiKey.model_allowlist.includes(modelId)
  ) {
    throw new BeaconError("The API key does not allow this model.", {
      status: 403,
      type: "permission_error",
      code: "model_not_allowed",
      param: "model",
    });
  }
  if (body.response_format !== undefined) {
    throw invalidRequest(
      "response_format is not enabled for this Beacon model.",
      "response_format",
      "unsupported_feature",
    );
  }
  const messages = validateMessages(body.messages);
  const usesTools =
    body.tools !== undefined ||
    body.tool_choice !== undefined ||
    messages.some((message) => message.role === "tool" || message.tool_calls !== undefined);
  if (usesTools && model.capabilities.tools !== true) {
    throw invalidRequest(
      "Tool calling is not enabled for this Beacon model.",
      "tools",
      "unsupported_feature",
    );
  }
  const tools = body.tools === undefined ? undefined : validateTools(body.tools);
  if (body.tool_choice !== undefined && !tools)
    throw invalidRequest("tool_choice requires tools.", "tool_choice");
  const toolChoice = validateToolChoice(body.tool_choice, tools || []);
  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    throw invalidRequest("stream must be a boolean.", "stream");
  }
  const stream = body.stream ?? false;
  if (stream && model.capabilities.streaming !== true) {
    throw invalidRequest("Streaming is not supported by this model.", "stream", "unsupported_feature");
  }
  if (
    body.max_completion_tokens !== undefined &&
    body.max_tokens !== undefined &&
    Number(body.max_completion_tokens) !== Number(body.max_tokens)
  ) {
    throw invalidRequest(
      "max_completion_tokens and max_tokens cannot specify different values.",
      "max_completion_tokens",
    );
  }
  const requestedMaxTokens = body.max_completion_tokens ?? body.max_tokens;
  const maxCompletionTokens =
    requestedMaxTokens === undefined
      ? model.limits.default_max_completion_tokens
      : integer(requestedMaxTokens, "max_completion_tokens", {
          minimum: 1,
          maximum: model.limits.max_completion_tokens,
        });
  const temperature =
    body.temperature === undefined
      ? undefined
      : finiteNumber(body.temperature, "temperature", { minimum: 0, maximum: 2 });
  const topP =
    body.top_p === undefined ? undefined : finiteNumber(body.top_p, "top_p", { minimum: 0, maximum: 1 });
  const presencePenalty =
    body.presence_penalty === undefined
      ? undefined
      : finiteNumber(body.presence_penalty, "presence_penalty", { minimum: -2, maximum: 2 });
  const frequencyPenalty =
    body.frequency_penalty === undefined
      ? undefined
      : finiteNumber(body.frequency_penalty, "frequency_penalty", { minimum: -2, maximum: 2 });
  const seed =
    body.seed === undefined
      ? undefined
      : integer(body.seed, "seed", { minimum: -2147483648, maximum: 2147483647 });
  const n = body.n === undefined ? undefined : integer(body.n, "n", { minimum: 1, maximum: 1 });
  const stop = body.stop === undefined ? undefined : validateStop(body.stop);
  const streamOptions = validateStreamOptions(body.stream_options, stream);
  const chatTemplateKwargs = validateChatTemplateKwargs(body.chat_template_kwargs, modelId);
  const normalizedIdempotencyKey =
    idempotencyKey === null || idempotencyKey === undefined || idempotencyKey === ""
      ? null
      : String(idempotencyKey);
  if (normalizedIdempotencyKey && !IDEMPOTENCY_KEY.test(normalizedIdempotencyKey)) {
    throw invalidRequest("Idempotency-Key must contain 1-200 visible ASCII characters.", "Idempotency-Key");
  }

  const upstreamBody = {
    model: modelId,
    messages,
    stream,
    max_completion_tokens: maxCompletionTokens,
    ...(streamOptions ? { stream_options: streamOptions } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(topP !== undefined ? { top_p: topP } : {}),
    ...(presencePenalty !== undefined ? { presence_penalty: presencePenalty } : {}),
    ...(frequencyPenalty !== undefined ? { frequency_penalty: frequencyPenalty } : {}),
    ...(seed !== undefined ? { seed } : {}),
    ...(n !== undefined ? { n } : {}),
    ...(stop !== undefined ? { stop } : {}),
    ...(chatTemplateKwargs ? { chat_template_kwargs: chatTemplateKwargs } : {}),
    ...(tools ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
  };
  const estimatedInputTokens = estimateInputTokens({ messages, ...(tools ? { tools } : {}) });
  let reservedCostMicros: ReturnType<typeof calculateReservationCostMicros>;
  try {
    reservedCostMicros = calculateReservationCostMicros(model, estimatedInputTokens, maxCompletionTokens);
  } catch (error) {
    if (error instanceof RangeError) {
      throw invalidRequest(
        "The request exceeds this Beacon model context limit.",
        "messages",
        "context_length_exceeded",
      );
    }
    throw error;
  }
  if (
    aiKey?.spend_limit_usd_micros !== null &&
    aiKey?.spend_limit_usd_micros !== undefined &&
    reservedCostMicros > Number(aiKey.spend_limit_usd_micros)
  ) {
    throw new BeaconError("The request exceeds this API key point limit.", {
      status: 402,
      type: "insufficient_funds_error",
      code: "spend_limit_exceeded",
    });
  }
  const id = requestId();
  const snapshot = createBillingSnapshot(modelId);
  const fingerprint = await createBeaconRequestFingerprint({
    endpoint: "chat.completions",
    body: upstreamBody,
  });

  return {
    requestId: id,
    created: Math.floor(Date.now() / 1000),
    modelId,
    model,
    routes: listCandidateRoutes(model),
    body: upstreamBody,
    stream,
    estimatedInputTokens,
    maxCompletionTokens,
    reservation: {
      requestId: id,
      userId: String(aiKey.user.id),
      apiKeyId: String(aiKey.id),
      idempotencyKey: normalizedIdempotencyKey,
      requestFingerprint: fingerprint,
      endpoint: "chat.completions",
      stream,
      publicModel: modelId,
      pricingRevision: snapshot.pricing_revision,
      pricingSnapshot: snapshot,
      reservedCostMicros,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    },
  };
}

export function publicProviderError(error: unknown) {
  if (error instanceof BeaconProviderError) {
    if (error.category === "client_disconnected") {
      return new BeaconError("The Beacon request was cancelled.", {
        status: 408,
        type: "invalid_request_error",
        code: "request_cancelled",
      });
    }
    if (error.category === "invalid_request") {
      return new BeaconError("Beacon could not process the supplied request.", {
        status: 400,
        type: "invalid_request_error",
        code: "invalid_request",
      });
    }
  } else if (error instanceof BeaconError && PUBLIC_BEACON_ERROR_CODES.has(error.code)) {
    return error;
  }
  return new BeaconError("Beacon is temporarily unable to process this request. Please retry shortly.", {
    status: 503,
    type: "server_error",
    code: "service_unavailable",
    retryAfter: 5,
  });
}

function tokenCount(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function publicUsage(usage: any, fallback: any = {}) {
  const normalized = normalizeProviderUsage(usage);
  if (normalized) return normalized;
  const promptTokens = tokenCount(usage?.prompt_tokens, tokenCount(fallback.inputTokens));
  const completionTokens = tokenCount(usage?.completion_tokens, tokenCount(fallback.outputTokens));
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: tokenCount(usage?.total_tokens, promptTokens + completionTokens),
  };
}

function publicFinishReason(value: unknown) {
  if (value === null || value === undefined) return null;
  return PUBLIC_FINISH_REASONS.has(value as string) ? value : "stop";
}

function publicMessage(message: any) {
  const safe: Record<string, any> = {
    role: "assistant",
    content: typeof message?.content === "string" || message?.content === null ? message.content : "",
  };
  if (typeof message?.reasoning === "string") safe.reasoning = message.reasoning;
  if (typeof message?.reasoning_content === "string") {
    safe.reasoning_content = message.reasoning_content;
  }
  if (typeof message?.refusal === "string" || message?.refusal === null) {
    safe.refusal = message.refusal;
  }
  if (Array.isArray(message?.tool_calls))
    safe.tool_calls = message.tool_calls.map((call: any) => ({
      id: call?.id,
      type: "function",
      function: { name: call?.function?.name, arguments: call?.function?.arguments },
    }));
  return safe;
}

function streamFailureCode(streamContext: any, error: any) {
  if (streamContext.invocation.result.didTimeout?.()) return "timeout";
  if (streamContext.invocation.result.wasExternallyAborted?.()) return "client_disconnected";
  const raw =
    typeof error?.category === "string"
      ? error.category
      : typeof error?.code === "string"
        ? error.code
        : typeof error?.name === "string"
          ? error.name
          : "stream_interrupted";
  return (
    raw
      .trim()
      .replace(/[^a-zA-Z0-9_.-]/g, "_")
      .slice(0, 80) || "stream_interrupted"
  );
}

function publicChoice(choice: any, index: number) {
  return {
    index:
      Number.isSafeInteger(Number(choice?.index)) && Number(choice.index) >= 0 ? Number(choice.index) : index,
    message: publicMessage(choice?.message),
    finish_reason: publicFinishReason(choice?.finish_reason),
  };
}

function publicDelta(delta: any) {
  const safe: Record<string, any> = {};
  if (delta?.role === "assistant") safe.role = "assistant";
  if (typeof delta?.content === "string") safe.content = delta.content;
  if (typeof delta?.reasoning === "string") safe.reasoning = delta.reasoning;
  if (typeof delta?.reasoning_content === "string") {
    safe.reasoning_content = delta.reasoning_content;
  }
  if (Array.isArray(delta?.tool_calls))
    safe.tool_calls = delta.tool_calls.map((call: any) => ({
      index: Number.isSafeInteger(Number(call?.index)) ? Number(call.index) : 0,
      ...(typeof call?.id === "string" ? { id: call.id } : {}),
      ...(call?.type ? { type: "function" } : {}),
      ...(isObject(call?.function)
        ? {
            function: {
              ...(typeof call.function.name === "string" ? { name: call.function.name } : {}),
              ...(typeof call.function.arguments === "string" ? { arguments: call.function.arguments } : {}),
            },
          }
        : {}),
    }));
  return safe;
}

function publicCompletion(result: any, prepared: any) {
  return {
    id: `chatcmpl_${prepared.requestId.slice(4)}`,
    object: "chat.completion",
    created: prepared.created,
    model: prepared.modelId,
    choices: result.payload.choices.map(publicChoice),
    usage: publicUsage(result.payload.usage, result),
  };
}

// 成功回應但 provider 未回報合法 usage 時的保守估計結算:不再進入隔離佇列
// 等待一小時後全額退款(平台吸收成本),改以「保留時的輸入估計 + 實際輸出
// 長度」計費並標記 usage_source='estimated'。settle 的 SQL 以
// LEAST(actual, reserved) 夾制,估計永不超過原保留額,維持絕不多收立場。
// 輸出以 ~4 字元/token 估計並加固定開銷,確保空回應也計入最低成本。
function estimateOutputTokensFromChars(chars: any) {
  return Math.ceil(Number(chars || 0) / 4) + 8;
}

function cappedEstimatedOutputTokens(prepared: any, outputChars: any) {
  const outputTokens = estimateOutputTokensFromChars(outputChars);
  const maxOutput = Number(prepared?.maxCompletionTokens);
  return Number.isSafeInteger(maxOutput) && maxOutput > 0 ? Math.min(outputTokens, maxOutput) : outputTokens;
}

// 測量公開串流 chunk 攜帶的輸出字元數(內容/推理文字與 tool call 引數片段);
// 串流消費端逐 chunk 累計到 streamContext.estimatedOutputChars,供串流完成
// 但未收到 usage chunk 時的估計結算。
export function measureStreamChunkOutputChars(chunk: any) {
  let chars = 0;
  for (const choice of Array.isArray(chunk?.choices) ? chunk.choices : []) {
    const delta = choice?.delta || {};
    for (const field of ["content", "reasoning", "reasoning_content"]) {
      if (typeof delta[field] === "string") chars += delta[field].length;
    }
    for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      if (typeof call?.function?.arguments === "string") chars += call.function.arguments.length;
    }
  }
  return chars;
}

// 測量非串流完成回應的輸出字元數(訊息內容與 tool call 引數)。
function completionPayloadOutputChars(payload: any) {
  let chars = 0;
  for (const choice of Array.isArray(payload?.choices) ? payload.choices : []) {
    const message = choice?.message || {};
    if (typeof message.content === "string") {
      chars += message.content.length;
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (typeof part?.text === "string") chars += part.text.length;
      }
    }
    if (typeof message.reasoning === "string") chars += message.reasoning.length;
    if (typeof message.reasoning_content === "string") chars += message.reasoning_content.length;
    for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
      if (typeof call?.function?.arguments === "string") chars += call.function.arguments.length;
    }
  }
  return chars;
}

export function createBeaconInferenceRuntime({
  billing,
  attempts = null,
  claimCredential,
  releaseCredential,
  fetchImpl = globalThis.fetch,
  cloudflareAiBinding = null,
}: any) {
  if (!billing || typeof billing.reserve !== "function") throw new TypeError("billing is required.");
  if (typeof claimCredential !== "function" || typeof releaseCredential !== "function") {
    throw new TypeError("Provider claim and release functions are required.");
  }

  async function reserve(prepared: any) {
    const reserved = await billing.reserve(prepared.reservation);
    if (reserved.idempotentReplay) throw replayError(reserved);
    await billing.markDispatched(reserved.requestId);
    return reserved;
  }

  async function invoke(prepared: any, signal: any) {
    let lastError: any;
    let attemptNumber = 0;
    // 保留單會在 expires_at 過期後被排程器回收。每個 attempt 最長可跑
    // route.timeout_ms;若保留單剩餘時間不足以再完整跑一個 attempt(含
    // 結算緩衝),必須停止重試,否則「仍在執行的請求」會被回收器判為
    // 過期並轉入 needs_reconciliation,使用者點數被多鎖一小時且平台吸收
    // 成本。第一個 attempt 不受此限制(保留單剛建立,必有完整額度)。
    const reservationDeadlineMs = Date.parse(prepared?.reservation?.expiresAt || "");
    const SETTLEMENT_BUFFER_MS = 15_000;
    for (const route of prepared.routes) {
      const routeTimeoutMs = Number(route?.timeout_ms) > 0 ? Number(route.timeout_ms) : 60_000;
      const attemptedCredentialIds = new Set<string>();
      while (attemptNumber < MAX_PROVIDER_ATTEMPTS) {
        if (
          attemptNumber > 0 &&
          Number.isFinite(reservationDeadlineMs) &&
          Date.now() + routeTimeoutMs + SETTLEMENT_BUFFER_MS > reservationDeadlineMs
        ) {
          break;
        }
        const claim = await claimCredential(route, prepared.requestId, [...attemptedCredentialIds]);
        if (!claim) break;
        if (attemptedCredentialIds.has(claim.credentialId)) {
          await releaseCredential(claim, {
            success: false,
            category: "duplicate_credential_suppressed",
          }).catch(() => {});
          break;
        }
        attemptedCredentialIds.add(claim.credentialId);
        attemptNumber += 1;
        const started = Date.now();
        let attempt: any = null;
        if (attempts?.start) {
          try {
            attempt = await attempts.start({
              requestId: prepared.requestId,
              attemptNumber,
              route,
              credentialId: claim.credentialId,
            });
          } catch (cause) {
            await releaseCredential(claim, {
              success: false,
              category: "attempt_audit_unavailable",
            }).catch(() => {});
            throw new BeaconProviderError("Provider attempt audit is unavailable.", {
              provider: route.provider,
              status: 503,
              category: "attempt_audit_unavailable",
              fallbackAllowed: false,
              cause,
            });
          }
          if (!attempt) {
            await releaseCredential(claim, {
              success: false,
              category: "attempt_audit_unavailable",
            }).catch(() => {});
            throw new BeaconProviderError("Provider attempt audit is unavailable.", {
              provider: route.provider,
              status: 503,
              category: "attempt_audit_unavailable",
              fallbackAllowed: false,
            });
          }
        }
        let result: any;
        try {
          result = await invokeProviderRoute({
            route,
            pool: claim.pool,
            credential: claim,
            body: prepared.body,
            fetchImpl,
            signal,
            cloudflareAiBinding,
          });
        } catch (error: any) {
          lastError = error;
          await attempts
            ?.finish?.(attempt, {
              success: false,
              httpStatus: Number(error?.status) || null,
              errorCategory: error?.category || error?.code || "provider_error",
              upstreamRequestId: error?.upstreamRequestId || null,
              latencyMs: Date.now() - started,
            })
            .catch(() => {});
          try {
            await releaseCredential(claim, {
              success: false,
              category: error?.category || "provider_error",
              latencyMs: Date.now() - started,
              retryAfter: error?.retryAfter ?? null,
            });
          } catch {
            // The lease expires automatically; do not mask provider fallback semantics.
          }
          if (!(error instanceof BeaconProviderError) || !error.fallbackAllowed || error.responseStarted)
            throw error;
          continue;
        }
        if (result.stream) return { result, route, claim, attempt, started };
        await attempts
          ?.finish?.(attempt, {
            success: true,
            httpStatus: 200,
            upstreamRequestId: result.upstreamRequestId,
            latencyMs: Date.now() - started,
          })
          .catch(() => {});
        try {
          await releaseCredential(claim, { success: true, latencyMs: Date.now() - started });
        } catch {
          // Provider success must never be repeated because lease bookkeeping failed.
        }
        return { result, route, claim: null, started };
      }
      if (attemptNumber >= MAX_PROVIDER_ATTEMPTS) break;
    }
    throw (
      lastError ||
      new BeaconProviderError("No provider capacity is available.", {
        provider: "none",
        status: 503,
        category: "no_provider_available",
        retryable: true,
        fallbackAllowed: false,
      })
    );
  }

  return Object.freeze({
    async executeJson(prepared: any, { signal }: any = {}) {
      await reserve(prepared);
      let invocation: any;
      try {
        invocation = await invoke(prepared, signal);
      } catch (error: any) {
        if (error?.usageUnknown === true) {
          await billing.markNeedsReconciliation({
            requestId: prepared.requestId,
            errorCode: error?.category || error?.code || "usage_unknown",
          });
        } else {
          await billing.refund({
            requestId: prepared.requestId,
            reason: error?.category || error?.code || "provider_failure",
            errorCode: error?.category || error?.code || "provider_failure",
            httpStatus: Number(error?.status) >= 400 ? Number(error.status) : 502,
          });
        }
        throw publicProviderError(error);
      }
      if (invocation.result.stream) {
        await releaseCredential(invocation.claim, { success: false, category: "protocol_mismatch" });
        await billing.markNeedsReconciliation({
          requestId: prepared.requestId,
          errorCode: "protocol_mismatch",
        });
        throw new BeaconError("Beacon returned an unexpected response.", {
          status: 503,
          type: "server_error",
          code: "service_unavailable",
          retryAfter: 5,
        });
      }
      if (invocation.result.usageSource !== "provider") {
        // 成功回應但缺合法 usage(如 Cloudflare legacy shape 一律 estimated):
        // 以保守估計結算,不再標記待核對(隔離一小時後全額退款)。
        const inputTokens = Number(prepared.estimatedInputTokens) || 0;
        const outputTokens = cappedEstimatedOutputTokens(
          prepared,
          completionPayloadOutputChars(invocation.result.payload),
        );
        try {
          await billing.settle({
            requestId: prepared.requestId,
            actualCostMicros: calculateActualCostMicros(prepared.model, inputTokens, outputTokens),
            inputTokens,
            outputTokens,
            usageSource: "estimated",
            totalLatencyMs: Date.now() - invocation.started,
          });
          // Return the same estimate that was settled, including visible reasoning.
          // Legacy adapters may have synthesized zero usage, so discard it here.
          invocation.result = {
            ...invocation.result,
            inputTokens,
            outputTokens,
            payload: { ...invocation.result.payload, usage: undefined },
          };
        } catch (error) {
          await billing.markNeedsReconciliation({
            requestId: prepared.requestId,
            errorCode: "settlement_failed",
          });
          throw error;
        }
      } else {
        try {
          await billing.settle({
            requestId: prepared.requestId,
            actualCostMicros: calculateActualCostMicros(
              prepared.model,
              invocation.result.inputTokens,
              invocation.result.outputTokens,
            ),
            inputTokens: invocation.result.inputTokens,
            outputTokens: invocation.result.outputTokens,
            usageSource: "provider",
            totalLatencyMs: Date.now() - invocation.started,
          });
        } catch (error) {
          await billing.markNeedsReconciliation({
            requestId: prepared.requestId,
            errorCode: "settlement_failed",
          });
          throw error;
        }
      }
      return {
        requestId: prepared.requestId,
        pricingRevision: BACKEND_PRICING.revision,
        body: publicCompletion(invocation.result, prepared),
      };
    },

    async openStream(prepared: any, { signal }: any = {}) {
      await reserve(prepared);
      let invocation: any;
      try {
        invocation = await invoke(prepared, signal);
      } catch (error: any) {
        if (error?.usageUnknown === true) {
          await billing.markNeedsReconciliation({
            requestId: prepared.requestId,
            errorCode: error?.category || error?.code || "usage_unknown",
          });
        } else {
          await billing.refund({
            requestId: prepared.requestId,
            reason: error?.category || error?.code || "provider_failure",
            errorCode: error?.category || error?.code || "provider_failure",
            httpStatus: Number(error?.status) >= 400 ? Number(error.status) : 502,
          });
        }
        throw publicProviderError(error);
      }
      if (!invocation.result.stream) {
        await billing.markNeedsReconciliation({
          requestId: prepared.requestId,
          errorCode: "protocol_mismatch",
        });
        throw new BeaconError("Beacon returned an unexpected response.", {
          status: 503,
          type: "server_error",
          code: "service_unavailable",
          retryAfter: 5,
        });
      }
      return {
        requestId: prepared.requestId,
        pricingRevision: BACKEND_PRICING.revision,
        prepared,
        invocation,
        events: parseSseStream(invocation.result.response.body),
        terminalPromise: null,
        // 由串流消費端逐 chunk 累計(aiPublic.ts),供缺 usage 時的估計結算。
        estimatedOutputChars: 0,
      };
    },

    async finalizeStream(streamContext: any, usage: any) {
      if (!streamContext.terminalPromise) {
        streamContext.terminalPromise = (async () => {
          const { invocation, requestId: id } = streamContext;
          invocation.result.dispose?.();
          await attempts
            ?.finish?.(invocation.attempt, {
              success: true,
              httpStatus: 200,
              upstreamRequestId: invocation.result.upstreamRequestId,
              latencyMs: Date.now() - invocation.started,
            })
            .catch(() => {});
          try {
            await releaseCredential(invocation.claim, {
              success: true,
              latencyMs: Date.now() - invocation.started,
            });
          } catch {
            // The database lease expires automatically; billing must still finalize.
          }
          if (!usage) {
            // 串流以 [DONE] 正常結束但未收到 usage chunk:與 JSON 路徑同立場,
            // 以估計輸入 + 實際輸出長度保守結算,不再隔離等待退款。
            const inputTokens = Number(streamContext.prepared.estimatedInputTokens) || 0;
            const outputTokens = cappedEstimatedOutputTokens(
              streamContext.prepared,
              streamContext.estimatedOutputChars,
            );
            try {
              return await billing.settle({
                requestId: id,
                actualCostMicros: calculateActualCostMicros(
                  streamContext.prepared.model,
                  inputTokens,
                  outputTokens,
                ),
                inputTokens,
                outputTokens,
                usageSource: "estimated",
                totalLatencyMs: Date.now() - invocation.started,
              });
            } catch (error) {
              await billing
                .markNeedsReconciliation({
                  requestId: id,
                  errorCode: "settlement_failed",
                })
                .catch(() => {});
              throw error;
            }
          }
          try {
            return await billing.settle({
              requestId: id,
              actualCostMicros: calculateActualCostMicros(
                streamContext.prepared.model,
                usage.prompt_tokens,
                usage.completion_tokens,
              ),
              inputTokens: usage.prompt_tokens,
              outputTokens: usage.completion_tokens,
              usageSource: "provider",
              totalLatencyMs: Date.now() - invocation.started,
            });
          } catch (error) {
            await billing
              .markNeedsReconciliation({
                requestId: id,
                errorCode: "settlement_failed",
              })
              .catch(() => {});
            throw error;
          }
        })();
      }
      return streamContext.terminalPromise;
    },

    async failStream(streamContext: any, error: any) {
      if (!streamContext.terminalPromise) {
        streamContext.terminalPromise = (async () => {
          const failureCode = streamFailureCode(streamContext, error);
          streamContext.invocation.result.dispose?.();
          await attempts
            ?.finish?.(streamContext.invocation.attempt, {
              success: false,
              httpStatus: Number(error?.status) || null,
              errorCategory: failureCode,
              upstreamRequestId: streamContext.invocation.result.upstreamRequestId,
              latencyMs: Date.now() - streamContext.invocation.started,
            })
            .catch(() => {});
          try {
            await releaseCredential(streamContext.invocation.claim, {
              success: false,
              category: failureCode,
              latencyMs: Date.now() - streamContext.invocation.started,
              retryAfter: error?.retryAfter ?? null,
            });
          } catch {
            // Reconciliation is more important than immediate lease bookkeeping.
          }
          // 若串流在中斷前已收到 provider 的 usage chunk,代表模型確實已產出
          // token,應依實際用量結算(settle)而非標記為待核對。舊實作一律
          // markNeedsReconciliation,導致點數停留在保留狀態、帳務不一致。
          const usage = streamContext.receivedUsage;
          if (usage && Number.isFinite(usage.prompt_tokens) && Number.isFinite(usage.completion_tokens)) {
            try {
              return await billing.settle({
                requestId: streamContext.requestId,
                actualCostMicros: calculateActualCostMicros(
                  streamContext.prepared.model,
                  usage.prompt_tokens,
                  usage.completion_tokens,
                ),
                inputTokens: usage.prompt_tokens,
                outputTokens: usage.completion_tokens,
                usageSource: "provider",
                totalLatencyMs: Date.now() - streamContext.invocation.started,
              });
            } catch (settleError) {
              await billing
                .markNeedsReconciliation({
                  requestId: streamContext.requestId,
                  errorCode: "settlement_failed",
                })
                .catch(() => {});
              throw settleError;
            }
          }

          return billing.markNeedsReconciliation({
            requestId: streamContext.requestId,
            errorCode: failureCode,
          });
        })();
      }
      return streamContext.terminalPromise;
    },
  });
}

export function normalizeStreamChunk(payload: any, prepared: any) {
  if (!isObject(payload))
    throw new BeaconProviderError("The provider emitted an invalid SSE payload.", {
      provider: "unknown",
      category: "invalid_provider_response",
      responseStarted: true,
      usageUnknown: true,
    });
  if (payload.error)
    throw new BeaconProviderError("The provider failed after streaming started.", {
      provider: "unknown",
      status: Number(payload.error.code) || 502,
      category: "midstream_provider_error",
      fallbackAllowed: false,
      responseStarted: true,
      usageUnknown: true,
    });
  const usage = normalizeProviderUsage(payload.usage);
  if (Array.isArray(payload.choices)) {
    return {
      id: `chatcmpl_${prepared.requestId.slice(4)}`,
      object: "chat.completion.chunk",
      created: prepared.created,
      model: prepared.modelId,
      choices: payload.choices.map((choice: any, index: number) => ({
        index:
          Number.isSafeInteger(Number(choice?.index)) && Number(choice.index) >= 0
            ? Number(choice.index)
            : index,
        delta: publicDelta(choice?.delta),
        finish_reason: publicFinishReason(choice?.finish_reason),
      })),
      ...(usage ? { usage } : {}),
    };
  }
  if (typeof payload.response === "string") {
    return {
      id: `chatcmpl_${prepared.requestId.slice(4)}`,
      object: "chat.completion.chunk",
      created: prepared.created,
      model: prepared.modelId,
      choices: [{ index: 0, delta: { content: payload.response }, finish_reason: null }],
      ...(usage ? { usage } : {}),
    };
  }
  if (usage) {
    return {
      id: `chatcmpl_${prepared.requestId.slice(4)}`,
      object: "chat.completion.chunk",
      created: prepared.created,
      model: prepared.modelId,
      choices: [],
      usage,
    };
  }
  if (payload.usage !== undefined && payload.usage !== null) {
    return {
      id: `chatcmpl_${prepared.requestId.slice(4)}`,
      object: "chat.completion.chunk",
      created: prepared.created,
      model: prepared.modelId,
      choices: [],
    };
  }
  if (Array.isArray(payload.tool_calls) && payload.tool_calls.length === 0) {
    return {
      id: `chatcmpl_${prepared.requestId.slice(4)}`,
      object: "chat.completion.chunk",
      created: prepared.created,
      model: prepared.modelId,
      choices: [],
    };
  }
  throw new BeaconProviderError("The provider emitted an unsupported SSE payload.", {
    provider: "unknown",
    category: "invalid_provider_response",
    responseStarted: true,
    usageUnknown: true,
  });
}
