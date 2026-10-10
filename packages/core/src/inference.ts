import type { AkentrosBillableBilling } from "./billing.ts";
import { createAkentrosRequestFingerprint } from "./billing.ts";
import { AkentrosError, invalidRequest } from "./openaiErrors.ts";
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
import type { AkentrosAttemptAuditor } from "./providerAttempts.ts";
import type { AkentrosCredentialClaim } from "./providerPool.ts";
import { AkentrosProviderError, invokeProviderRoute, normalizeProviderUsage } from "./providers.ts";
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
// ECO-02:對閘道中立、可安全忽略的 OpenAI 參數(user 追蹤標識、store、
// metadata、service_tier 等 SDK 常見預設欄位):接受後丟棄,不轉發、不進
// 指紋 —— 指紋針對 sanitised 後的 upstream body 計算,容忍欄位自然不在
// 其中,同鍵同體重放語意維持不變(與 LiteLLM/one-api 的「未知參數預設
// 忽略」對齊)。語意相關的欄位(logprobs、top_logprobs、parallel_tool_calls、
// functions、function_call)刻意不納入:靜默忽略會改變回應或行為,維持
// 400 並讓錯誤訊息指名欄位。
const TOLERATED_IGNORED_FIELDS = new Set(["user", "store", "metadata", "service_tier"]);
const PUBLIC_AKENTROS_ERROR_CODES = new Set([
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
  "request_too_large",
  // FN-2 fix 配套:深巢狀 JSON 的 400 錯誤碼必須在公開白名單內,
  // 否則 publicProviderError 會把 prepare 的 400 改寫成 503。
  "request_too_complex",
  "spend_limit_exceeded",
  "insufficient_balance",
  "free_quota_exceeded",
  "rate_limit_exceeded",
  "max_in_flight_exceeded",
  "idempotency_conflict",
  "idempotency_replay_not_stored",
  "idempotent_request_in_progress",
  "idempotent_request_replayed",
  "request_cancelled",
  "route_not_found",
  "service_unavailable",
]);
const MAX_PROVIDER_ATTEMPTS = 8;
// messages[].tool_calls[].function.arguments 是任意長度的 JSON 字串;HTTP 層
// 已有 32MB 請求體上限,此處再加欄位級上限作縱深防禦,避免合法請求體內塞入
// 超大字串拖累指紋計算與上游轉發。
const MAX_TOOL_CALL_ARGUMENTS_CHARS = 256 * 1024;
// tools[].function.parameters 為任意 JSON Schema;序列化長度上限同上。
const MAX_TOOL_PARAMETERS_JSON_CHARS = 64 * 1024;
// ECO-01:response_format 的 json_schema.schema 與 tools 的 parameters
// 同為任意 JSON Schema,沿用同一組大小/深度防護,避免合法請求體內塞入
// 超大 schema 拖累指紋計算與上游轉發。
const MAX_RESPONSE_FORMAT_SCHEMA_JSON_CHARS = MAX_TOOL_PARAMETERS_JSON_CHARS;
// Recursive JSON.stringify throws RangeError beyond ~4.4k nesting levels; far
// below that we reject with a 400 instead of letting serialization explode in
// validateTools, token estimation, or the upstream fetch body.
const MAX_REQUEST_JSON_DEPTH = 64;

function requestId() {
  return `req_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
}

function isObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Iterative (non-recursive) max nesting depth probe. A recursive walk would
// itself throw RangeError on the exact inputs it is meant to measure.
function maxJsonDepth(root: unknown): number {
  if (root === null || typeof root !== "object") return 1;
  let max = 1;
  const stack: Array<{ node: unknown; depth: number }> = [{ node: root, depth: 1 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop() as { node: unknown; depth: number };
    if (depth > max) max = depth;
    if (node !== null && typeof node === "object") {
      for (const key of Object.keys(node)) {
        const child = (node as Record<string, unknown>)[key];
        if (child !== null && typeof child === "object") stack.push({ node: child, depth: depth + 1 });
      }
    }
  }
  return max;
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
  if (!isObject(value) || typeof (value as any).thinking !== "boolean" || Object.keys(value).length !== 1)
    throw invalidRequest(
      "chat_template_kwargs must be an object with a single boolean thinking field.",
      "chat_template_kwargs",
      "unsupported_parameter",
    );
  return { thinking: (value as any).thinking };
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
  if (value.arguments.length > MAX_TOOL_CALL_ARGUMENTS_CHARS)
    throw invalidRequest(
      `${label}.arguments exceeds the supported length.`,
      `${label}.arguments`,
      "request_too_large",
    );
  return { name: value.name, arguments: value.arguments };
}

// ECO-03:vision 輸入的 content parts 上限。每 part 文字 ≤100k(沿用純文字
// 訊息上限)、URL ≤8k、parts ≤64,總體沿用 HTTP 層 32MB body 上限。
const MAX_MESSAGE_CONTENT_PARTS = 64;
const MAX_IMAGE_URL_CHARS = 8 * 1024;
// 每個 image part 以固定保守值計入輸入 token 估計(起跳 1,000;URL 位元組
// 已在 JSON 序列化估計內,此值補上「圖片本體」未被 URL 長度反映的成本),
// 依解析度精化留待後續。預留額邏輯沿用,確保不高估不足額。
const IMAGE_PART_ESTIMATED_INPUT_TOKENS = 1_000;

// ECO-03:vision 能力開啟的模型,user 訊息 content 可為 parts 陣列
// ({type:"text"} 與 {type:"image_url"} 混合)。image_url 只接受 https://
// 與 data:image/ 基底,防 file:// 等奇怪 scheme 直接透傳上游。
function validateContentParts(value: unknown, label: string): any[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MESSAGE_CONTENT_PARTS) {
    throw invalidRequest(
      `Message content parts must contain between 1 and ${MAX_MESSAGE_CONTENT_PARTS} items.`,
      label,
    );
  }
  return value.map((part: any, index: number) => {
    const partLabel = `${label}.${index}`;
    if (isObject(part) && part.type === "text") {
      if (Object.keys(part).some((key) => key !== "type" && key !== "text")) {
        throw invalidRequest("Text parts must only contain the type and text fields.", partLabel);
      }
      if (typeof part.text !== "string" || part.text.length === 0 || part.text.length > 100_000) {
        throw invalidRequest("Text parts must contain 1-100000 characters.", `${partLabel}.text`);
      }
      return { type: "text", text: part.text };
    }
    if (isObject(part) && part.type === "image_url") {
      if (
        Object.keys(part).some((key) => key !== "type" && key !== "image_url") ||
        !isObject(part.image_url) ||
        Object.keys(part.image_url).some((key) => key !== "url")
      ) {
        throw invalidRequest("Image parts must only contain an image_url object with a url.", partLabel);
      }
      const url = part.image_url.url;
      if (typeof url !== "string" || url.length === 0 || url.length > MAX_IMAGE_URL_CHARS) {
        throw invalidRequest("Image URLs must contain 1-8192 characters.", `${partLabel}.image_url.url`);
      }
      if (!url.startsWith("https://") && !url.startsWith("data:image/")) {
        throw invalidRequest(
          "Image URLs must use https:// or data:image/ sources.",
          `${partLabel}.image_url.url`,
        );
      }
      return { type: "image_url", image_url: { url } };
    }
    throw invalidRequest("Message content parts must be text or image_url items.", partLabel);
  });
}

function validateMessages(messages: unknown, { vision = false }: { vision?: boolean } = {}): any[] {
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
    let content: any;
    if (hasToolCalls) {
      // Assistant tool-call turns may carry null content (or a short string of
      // interleaved text), but never structured content parts — the public
      // contract declares content as string|null for every non-user role.
      if (message.content !== undefined && message.content !== null && typeof message.content !== "string")
        throw invalidRequest("Message content must be a string or null.", `${label}.content`);
      content = message.content === undefined || message.content === null ? null : message.content;
    } else if (Array.isArray(message.content)) {
      // ECO-03:content parts 僅開放給 vision 能力模型上的 user 訊息
      // (視覺輸入的實際載體);其餘角色維持 string|null 契約。
      if (message.role !== "user" || !vision) {
        throw invalidRequest("Message content must be a string or null.", `${label}.content`);
      }
      content = validateContentParts(message.content, `${label}.content`);
    } else if (typeof message.content !== "string" || message.content.length === 0) {
      throw invalidRequest(
        "Messages require non-empty text content or assistant tool calls.",
        `${label}.content`,
      );
    } else {
      content = message.content;
    }
    if (typeof content === "string" && content.length > 100_000) {
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
      content,
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
    if (maxJsonDepth(fn.parameters) > MAX_REQUEST_JSON_DEPTH)
      throw invalidRequest(
        "Tool parameters exceed the supported nesting depth.",
        `${label}.function.parameters`,
        "request_too_complex",
      );
    let serializedParameters: string;
    try {
      serializedParameters = JSON.stringify(fn.parameters) ?? "";
    } catch (error) {
      if (error instanceof RangeError)
        throw invalidRequest(
          "Tool parameters exceed the supported nesting depth.",
          `${label}.function.parameters`,
          "request_too_complex",
        );
      throw error;
    }
    if (serializedParameters.length > MAX_TOOL_PARAMETERS_JSON_CHARS)
      throw invalidRequest(
        "Tool parameters exceed the supported size.",
        `${label}.function.parameters`,
        "request_too_large",
      );
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

// ECO-01:response_format 的分型處理。
// - text:OpenAI 預設值,靜默等同未指定(不轉發、不拒絕)。
// - json_object(JSON mode):需模型 capabilities.json_mode,僅接受
//   {type:"json_object"} 形狀,以 {type:"json_object"} 轉發。
// - json_schema(structured outputs):需模型 capabilities.structured_outputs,
//   驗證 {type, json_schema:{name, description?, schema, strict?}} 形狀與
//   大小/深度上限後原樣轉發給 OpenAI 相容上游(Anthropic Messages API
//   無 response_format,能力旗標一律 false,在此就會被擋下)。
// - 其餘形狀(非物件、缺 type、未知 type):400 指名 response_format。
// 能力未開啟時回 400 unsupported_feature(param 為 response_format),
// 錯誤與「形狀不合法」可分辨,遷移者能立即定位是能力問題還是請求問題。
function validateResponseFormat(value: unknown, model: any) {
  if (value === undefined) return undefined;
  if (!isObject(value)) {
    throw invalidRequest(
      "response_format.type must be one of text, json_object, or json_schema.",
      "response_format",
    );
  }
  const type = value.type;
  if (type === "text") {
    // text 即預設行為:不轉發、不拒絕,靜默等同未指定。
    return undefined;
  }
  if (type === "json_object") {
    if (model.capabilities.json_mode !== true) {
      throw invalidRequest(
        "JSON mode (response_format json_object) is not enabled for this Akentros model.",
        "response_format",
        "unsupported_feature",
      );
    }
    if (Object.keys(value).some((key) => key !== "type")) {
      throw invalidRequest(
        "response_format with type json_object must only contain the type field.",
        "response_format",
      );
    }
    return { type: "json_object" };
  }
  if (type === "json_schema") {
    if (model.capabilities.structured_outputs !== true) {
      throw invalidRequest(
        "Structured outputs are not enabled for this Akentros model.",
        "response_format",
        "unsupported_feature",
      );
    }
    const jsonSchema: unknown = value.json_schema;
    if (
      !isObject(jsonSchema) ||
      typeof jsonSchema.name !== "string" ||
      jsonSchema.name.length < 1 ||
      jsonSchema.name.length > 64 ||
      !isObject(jsonSchema.schema) ||
      Object.keys(jsonSchema).some((key) => !["name", "description", "schema", "strict"].includes(key))
    ) {
      throw invalidRequest(
        "response_format.json_schema must be an object with a name and a JSON Schema.",
        "response_format",
      );
    }
    if (jsonSchema.description !== undefined && typeof jsonSchema.description !== "string") {
      throw invalidRequest("response_format.json_schema.description must be a string.", "response_format");
    }
    if (jsonSchema.strict !== undefined && typeof jsonSchema.strict !== "boolean") {
      throw invalidRequest("response_format.json_schema.strict must be a boolean.", "response_format");
    }
    if (maxJsonDepth(jsonSchema.schema) > MAX_REQUEST_JSON_DEPTH) {
      throw invalidRequest(
        "response_format.json_schema.schema exceeds the supported nesting depth.",
        "response_format",
        "request_too_complex",
      );
    }
    let serializedSchema: string;
    try {
      serializedSchema = JSON.stringify(jsonSchema.schema) ?? "";
    } catch (error) {
      if (error instanceof RangeError) {
        throw invalidRequest(
          "response_format.json_schema.schema exceeds the supported nesting depth.",
          "response_format",
          "request_too_complex",
        );
      }
      throw error;
    }
    if (serializedSchema.length > MAX_RESPONSE_FORMAT_SCHEMA_JSON_CHARS) {
      throw invalidRequest(
        "response_format.json_schema.schema exceeds the supported size.",
        "response_format",
        "request_too_large",
      );
    }
    return {
      type: "json_schema",
      json_schema: {
        name: jsonSchema.name,
        ...(jsonSchema.description !== undefined ? { description: jsonSchema.description } : {}),
        schema: jsonSchema.schema,
        ...(jsonSchema.strict !== undefined ? { strict: jsonSchema.strict } : {}),
      },
    };
  }
  throw invalidRequest(
    "response_format.type must be one of text, json_object, or json_schema.",
    "response_format",
  );
}

function replayError(reserved: { status?: string; requestId: string }) {
  const inProgress = reserved.status === "dispatched" || reserved.status === "reserved";
  const error = new AkentrosError(
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

function normalizePublicIdempotencyKey(idempotencyKey: string | null | undefined) {
  if (idempotencyKey === null || idempotencyKey === undefined || idempotencyKey === "") return null;
  const normalized = String(idempotencyKey);
  if (!IDEMPOTENCY_KEY.test(normalized)) {
    throw invalidRequest("Idempotency-Key must contain 1-200 visible ASCII characters.", "Idempotency-Key");
  }
  return normalized;
}

// 公開 embeddings 請求的驗證與保留單準備。與 chat 同一套模型解析、白名單、
// spend limit 與計費狀態機;差異:無串流、無輸出 token(保留額以輸出 0 計算),
// usage 僅含 prompt_tokens/total_tokens。
const PUBLIC_EMBEDDINGS_FIELDS = new Set(["model", "input", "dimensions", "encoding_format"]);
const MAX_EMBEDDINGS_ITEMS = 2048;
const MAX_EMBEDDINGS_ITEM_CHARS = 100_000;
const MAX_EMBEDDINGS_DIMENSIONS = 3072;

function validateEmbeddingsInput(value: unknown): string[] {
  const items = typeof value === "string" ? [value] : value;
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_EMBEDDINGS_ITEMS) {
    throw invalidRequest("input must be a string or an array of 1-2048 strings.", "input");
  }
  return items.map((item: unknown, index: number) => {
    if (typeof item !== "string" || item.length === 0) {
      throw invalidRequest("input items must be non-empty strings.", `input.${index}`);
    }
    if (item.length > MAX_EMBEDDINGS_ITEM_CHARS) {
      throw invalidRequest("An input item exceeds the supported text length.", `input.${index}`);
    }
    return item;
  });
}

export async function prepareAkentrosEmbeddingsRequest({
  body,
  aiKey,
  idempotencyKey = null,
}: {
  body: any;
  aiKey: any;
  idempotencyKey?: string | null;
}) {
  if (!isObject(body)) throw invalidRequest("The request body must be a JSON object.");
  const unsupportedField = Object.keys(body).find((field) => !PUBLIC_EMBEDDINGS_FIELDS.has(field));
  if (unsupportedField) {
    throw invalidRequest(
      `The parameter '${unsupportedField}' is not supported by Akentros.`,
      unsupportedField,
      "unsupported_parameter",
    );
  }
  const modelId = typeof body.model === "string" ? body.model.trim() : "";
  let model: ReturnType<typeof requireModelPricing>;
  try {
    model = requireModelPricing(modelId);
  } catch {
    throw new AkentrosError(`The model '${modelId || "unknown"}' does not exist or is disabled.`, {
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
    throw new AkentrosError("The API key does not allow this model.", {
      status: 403,
      type: "permission_error",
      code: "model_not_allowed",
      param: "model",
    });
  }
  if (model.capabilities.embeddings !== true) {
    throw invalidRequest(
      "This Akentros model does not support the embeddings API.",
      "model",
      "unsupported_feature",
    );
  }
  const input = validateEmbeddingsInput(body.input);
  const dimensions =
    body.dimensions === undefined
      ? undefined
      : integer(body.dimensions, "dimensions", { minimum: 1, maximum: MAX_EMBEDDINGS_DIMENSIONS });
  const encodingFormat = body.encoding_format === undefined ? "float" : body.encoding_format;
  if (encodingFormat !== "float" && encodingFormat !== "base64") {
    throw invalidRequest("encoding_format must be either float or base64.", "encoding_format");
  }
  const normalizedIdempotencyKey = normalizePublicIdempotencyKey(idempotencyKey);

  const upstreamBody = {
    model: modelId,
    input,
    ...(dimensions !== undefined ? { dimensions } : {}),
    ...(body.encoding_format !== undefined ? { encoding_format: encodingFormat } : {}),
  };
  const estimatedInputTokens = estimateInputTokens({ input });
  const reservedCostMicros = calculateReservationCostMicros(model, estimatedInputTokens, 0);
  if (
    aiKey?.spend_limit_usd_micros !== null &&
    aiKey?.spend_limit_usd_micros !== undefined &&
    reservedCostMicros > Number(aiKey.spend_limit_usd_micros)
  ) {
    throw new AkentrosError("The request exceeds this API key point limit.", {
      status: 402,
      type: "insufficient_funds_error",
      code: "spend_limit_exceeded",
    });
  }
  const id = requestId();
  const snapshot = createBillingSnapshot(modelId);
  const fingerprint = await createAkentrosRequestFingerprint({
    endpoint: "embeddings",
    body: upstreamBody,
  });

  return {
    requestId: id,
    created: Math.floor(Date.now() / 1000),
    modelId,
    model,
    endpoint: "embeddings",
    routes: listCandidateRoutes(model),
    body: upstreamBody,
    estimatedInputTokens,
    reservation: {
      requestId: id,
      userId: String(aiKey.user.id),
      apiKeyId: String(aiKey.id),
      idempotencyKey: normalizedIdempotencyKey,
      requestFingerprint: fingerprint,
      endpoint: "embeddings",
      stream: false,
      publicModel: modelId,
      pricingRevision: snapshot.pricing_revision,
      pricingSnapshot: snapshot,
      reservedCostMicros,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    },
  };
}

export function listPublicAkentrosModels(config = BACKEND_PRICING) {
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

export async function prepareAkentrosChatRequest({
  body,
  aiKey,
  idempotencyKey = null,
}: {
  body: any;
  aiKey: any;
  idempotencyKey?: string | null;
}) {
  // ECO-04 P2:/responses 橋接共用同一套 chat 準備邏輯,僅 endpoint 標籤
  // 不同(計費、指紋與請求紀錄都要能分辨回應是哪個公開端點來的)。
  return prepareAkentrosChatBody({ body, aiKey, idempotencyKey, endpoint: "chat.completions" });
}

async function prepareAkentrosChatBody({
  body,
  aiKey,
  idempotencyKey = null,
  endpoint = "chat.completions",
}: {
  body: any;
  aiKey: any;
  idempotencyKey?: string | null;
  endpoint?: string;
}) {
  if (!isObject(body)) throw invalidRequest("The request body must be a JSON object.");
  // ECO-02:白名單外的欄位回 400 unsupported_parameter;但對閘道中立、
  // 可安全忽略的 OpenAI 參數(TOLERATED_IGNORED_FIELDS)接受後丟棄,
  // 不轉發、不進指紋,讓 SDK 預設呼叫與常見使用者程式碼不再踩雷。
  const unsupportedField = Object.keys(body).find(
    (field) => !PUBLIC_REQUEST_FIELDS.has(field) && !TOLERATED_IGNORED_FIELDS.has(field),
  );
  if (unsupportedField) {
    throw invalidRequest(
      `The parameter '${unsupportedField}' is not supported by Akentros.`,
      unsupportedField,
      "unsupported_parameter",
    );
  }
  const modelId = typeof body.model === "string" ? body.model.trim() : "";
  let model: ReturnType<typeof requireModelPricing>;
  try {
    model = requireModelPricing(modelId);
  } catch {
    throw new AkentrosError(`The model '${modelId || "unknown"}' does not exist or is disabled.`, {
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
    throw new AkentrosError("The API key does not allow this model.", {
      status: 403,
      type: "permission_error",
      code: "model_not_allowed",
      param: "model",
    });
  }
  if (model.capabilities.chat_completions !== true) {
    throw invalidRequest(
      "This Akentros model does not support chat completions.",
      "model",
      "unsupported_feature",
    );
  }
  // ECO-01:response_format 分型處理(見 validateResponseFormat)。
  const responseFormat = validateResponseFormat(body.response_format, model);
  // ECO-03:vision 能力開啟的模型,user 訊息可攜帶混合 text/image_url parts。
  const messages = validateMessages(body.messages, { vision: model.capabilities.vision === true });
  const usesTools =
    body.tools !== undefined ||
    body.tool_choice !== undefined ||
    messages.some((message) => message.role === "tool" || message.tool_calls !== undefined);
  if (usesTools && model.capabilities.tools !== true) {
    throw invalidRequest(
      "Tool calling is not enabled for this Akentros model.",
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
  // ECO-05:維持僅支援 n=1(最小方案),但錯誤改為明確的 unsupported_feature
  // 並直接告訴遷移者替代做法;形狀不合法(非正整數)仍回一般 400。
  let n: number | undefined;
  if (body.n !== undefined) {
    const parsed = Number(body.n);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      throw invalidRequest("n must be a positive integer.", "n");
    }
    if (parsed > 1) {
      throw invalidRequest(
        "Multiple choices (n>1) are not supported; send separate requests.",
        "n",
        "unsupported_feature",
      );
    }
    n = parsed;
  }
  const stop = body.stop === undefined ? undefined : validateStop(body.stop);
  const streamOptions = validateStreamOptions(body.stream_options, stream);
  const chatTemplateKwargs = validateChatTemplateKwargs(body.chat_template_kwargs, modelId);
  const normalizedIdempotencyKey = normalizePublicIdempotencyKey(idempotencyKey);

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
    ...(responseFormat !== undefined ? { response_format: responseFormat } : {}),
    ...(tools ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
  };
  let estimatedInputTokens: number;
  try {
    // ECO-03:image part 另以固定保守值計入(URL 位元組已在序列化估計內),
    // 預留額不因圖片未被 URL 長度反映而低估。
    const imagePartCount = messages.reduce(
      (count: number, message: any) =>
        count +
        (Array.isArray(message.content)
          ? message.content.filter((part: any) => part?.type === "image_url").length
          : 0),
      0,
    );
    estimatedInputTokens =
      estimateInputTokens({ messages, ...(tools ? { tools } : {}) }) +
      imagePartCount * IMAGE_PART_ESTIMATED_INPUT_TOKENS;
  } catch (error) {
    if (error instanceof RangeError)
      throw invalidRequest(
        "The request exceeds the supported complexity.",
        "messages",
        "request_too_complex",
      );
    throw error;
  }
  let reservedCostMicros: ReturnType<typeof calculateReservationCostMicros>;
  try {
    reservedCostMicros = calculateReservationCostMicros(model, estimatedInputTokens, maxCompletionTokens);
  } catch (error) {
    if (error instanceof RangeError) {
      throw invalidRequest(
        "The request exceeds this Akentros model context limit.",
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
    throw new AkentrosError("The request exceeds this API key point limit.", {
      status: 402,
      type: "insufficient_funds_error",
      code: "spend_limit_exceeded",
    });
  }
  const id = requestId();
  const snapshot = createBillingSnapshot(modelId);
  const fingerprint = await createAkentrosRequestFingerprint({
    endpoint,
    body: upstreamBody,
  });

  return {
    requestId: id,
    created: Math.floor(Date.now() / 1000),
    modelId,
    model,
    endpoint,
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
      endpoint,
      stream,
      publicModel: modelId,
      pricingRevision: snapshot.pricing_revision,
      pricingSnapshot: snapshot,
      reservedCostMicros,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    },
  };
}

// ECO-04 P2:/responses → chat/completions 橋接的請求面。
// 支援子集:model、input(string 或 message 陣列,含 vision 的
// input_text/input_image parts)、instructions(→ system)、stream、
// max_output_tokens(→ max_completion_tokens)、temperature、top_p。
// 已知進階功能(background、previous_response_id、tools、reasoning、
// text.format …)回 400 unsupported_feature,其餘未知欄位回
// unsupported_parameter;對閘道中立的參數(user/store/metadata/
// service_tier)與 chat 同一批容忍丟棄。執行、計費(reserve→settle→
// refund)與上游選路完全共用 chat 管線,endpoint 欄位標 `responses`。
const PUBLIC_RESPONSES_FIELDS = new Set([
  "model",
  "input",
  "instructions",
  "stream",
  "max_output_tokens",
  "temperature",
  "top_p",
]);
const RESPONSES_UNSUPPORTED_FEATURES = new Set([
  "background",
  "previous_response_id",
  "conversation",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning",
  "text",
  "include",
  "truncation",
  "prompt",
  "prompt_template",
]);

// Responses 的 input items:EasyInputMessage 形狀 —— {role, content},
// content 為字串或 parts 陣列;parts 型別為 input_text / input_image
// (Responses 面的命名,非 chat 的 text/image_url),轉換為 chat 的
// parts 形狀後交给 validateMessages 走同一套限制(vision 旗標、URL
// 基底、長度上限)。
function responsesInputToMessages(input: unknown, instructions: unknown): any[] {
  if (input !== undefined && typeof input !== "string" && !Array.isArray(input)) {
    throw invalidRequest("input must be a string or an array of message items.", "input");
  }
  const messages: any[] = [];
  if (typeof instructions === "string" && instructions.length > 0) {
    messages.push({ role: "system", content: instructions });
  } else if (instructions !== undefined && instructions !== null) {
    throw invalidRequest("instructions must be a string.", "instructions");
  }
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
    return messages;
  }
  for (const [index, item] of (Array.isArray(input) ? input : []).entries()) {
    const label = `input.${index}`;
    if (!isObject(item) || typeof item.role !== "string") {
      throw invalidRequest("Each input item must be an object with a role.", label);
    }
    if (!["system", "developer", "user", "assistant"].includes(item.role)) {
      throw invalidRequest(
        "input items only support system, developer, user, and assistant roles.",
        `${label}.role`,
      );
    }
    if (item.role === "user" && Array.isArray(item.content)) {
      messages.push({
        role: "user",
        content: item.content.map((part: any, partIndex: number) => {
          const partLabel = `${label}.content.${partIndex}`;
          if (isObject(part) && part.type === "input_text") {
            return { type: "text", text: part.text };
          }
          if (isObject(part) && part.type === "input_image") {
            const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
            if (typeof url !== "string") {
              throw invalidRequest(
                "input_image parts require an image_url string.",
                `${partLabel}.image_url`,
              );
            }
            return { type: "image_url", image_url: { url } };
          }
          throw invalidRequest("input content parts must be input_text or input_image items.", partLabel);
        }),
      });
      continue;
    }
    if (item.role !== "user" && Array.isArray(item.content)) {
      throw invalidRequest("Content parts are only supported on user input items.", `${label}.content`);
    }
    if (typeof item.content !== "string" || item.content.length === 0) {
      throw invalidRequest("Input items require non-empty text content.", `${label}.content`);
    }
    messages.push({ role: item.role, content: item.content });
  }
  if (messages.filter((message) => message.role !== "system" && message.role !== "developer").length === 0) {
    throw invalidRequest("input must contain at least one user or assistant message.", "input");
  }
  return messages;
}

export async function prepareAkentrosResponsesRequest({
  body,
  aiKey,
  idempotencyKey = null,
}: {
  body: any;
  aiKey: any;
  idempotencyKey?: string | null;
}) {
  if (!isObject(body)) throw invalidRequest("The request body must be a JSON object.");
  // 與 chat 同一批「對閘道中立」容忍欄位(responses API 的 store 由服務
  // 端預設開啟,Akentros 不落地回應,接受後丟棄即可)。
  const unsupportedField = Object.keys(body).find(
    (field) =>
      !PUBLIC_RESPONSES_FIELDS.has(field) &&
      !TOLERATED_IGNORED_FIELDS.has(field) &&
      !RESPONSES_UNSUPPORTED_FEATURES.has(field),
  );
  if (unsupportedField) {
    throw invalidRequest(
      `The parameter '${unsupportedField}' is not supported by Akentros.`,
      unsupportedField,
      "unsupported_parameter",
    );
  }
  const unsupportedFeature = Object.keys(body).find((field) => RESPONSES_UNSUPPORTED_FEATURES.has(field));
  if (unsupportedFeature) {
    throw invalidRequest(
      `The parameter '${unsupportedFeature}' names an OpenAI Responses feature that Akentros does not support yet.`,
      unsupportedFeature,
      "unsupported_feature",
    );
  }
  const modelId = typeof body.model === "string" ? body.model.trim() : "";
  let model: ReturnType<typeof requireModelPricing>;
  try {
    model = requireModelPricing(modelId);
  } catch {
    throw new AkentrosError(`The model '${modelId || "unknown"}' does not exist or is disabled.`, {
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
    throw new AkentrosError("The API key does not allow this model.", {
      status: 403,
      type: "permission_error",
      code: "model_not_allowed",
      param: "model",
    });
  }
  if (model.capabilities.chat_completions !== true) {
    throw invalidRequest(
      "This Akentros model does not support the responses API.",
      "model",
      "unsupported_feature",
    );
  }
  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    throw invalidRequest("stream must be a boolean.", "stream");
  }
  const stream = body.stream ?? false;
  if (stream && model.capabilities.streaming !== true) {
    throw invalidRequest("Streaming is not supported by this model.", "stream", "unsupported_feature");
  }
  const messages = responsesInputToMessages(body.input, body.instructions);
  // 轉換為 chat 形狀後,交給共享的 chat 準備管線(endpoint 標 responses)。
  // 回應包裝(publicResponsesObject)與 SSE 橋接(streamBridge)由端點層
  // 負責;這裡回傳的 body 就是 chat/completions 上游體。instructions 原樣
  // 附在 prepared 上供回應面回票(OpenAI 慣例)。
  const prepared = await prepareAkentrosChatBody({
    body: {
      model: modelId,
      messages,
      stream,
      ...(body.max_output_tokens !== undefined ? { max_completion_tokens: body.max_output_tokens } : {}),
      ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
      ...(body.top_p !== undefined ? { top_p: body.top_p } : {}),
    },
    aiKey,
    idempotencyKey,
    endpoint: "responses",
  });
  return { ...prepared, instructions: typeof body.instructions === "string" ? body.instructions : null };
}

export function publicProviderError(error: unknown) {
  if (error instanceof AkentrosProviderError) {
    if (error.category === "client_disconnected") {
      return new AkentrosError("The Akentros request was cancelled.", {
        status: 408,
        type: "invalid_request_error",
        code: "request_cancelled",
      });
    }
    if (error.category === "invalid_request") {
      return new AkentrosError("Akentros could not process the supplied request.", {
        status: 400,
        type: "invalid_request_error",
        code: "invalid_request",
      });
    }
  } else if (error instanceof AkentrosError && PUBLIC_AKENTROS_ERROR_CODES.has(error.code)) {
    return error;
  }
  return new AkentrosError("Akentros is temporarily unable to process this request. Please retry shortly.", {
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

// ECO-04 P2:/responses 橋接的回應面 —— 把公開 chat completion 包回
// Responses API 的 response 物件。第一版輸出面僅 message/output_text
// (工具呼叫不支援,請求面已提前擋下);finish_reason=length 映射為
// status=incomplete + incomplete_details,其餼 completed。usage 欄位名
// 依 Responses 慣例(input_tokens / output_tokens / total_tokens)。
function responsesAssistantText(chatBody: any): string {
  const choice = Array.isArray(chatBody?.choices) ? chatBody.choices[0] : null;
  if (choice?.message && typeof choice.message.content === "string") return choice.message.content;
  return "";
}

function responsesFinishReason(chatBody: any): string | null {
  const choice = Array.isArray(chatBody?.choices) ? chatBody.choices[0] : null;
  return choice?.finish_reason ?? null;
}

export function publicResponsesObject(chatBody: any, prepared: any) {
  const text = responsesAssistantText(chatBody);
  const finishReason = responsesFinishReason(chatBody);
  const incomplete = finishReason === "length";
  const usage = chatBody?.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const messageId = `msg_${prepared.requestId.slice(4)}`;
  return {
    id: `resp_${prepared.requestId.slice(4)}`,
    object: "response",
    created_at: prepared.created,
    status: incomplete ? "incomplete" : "completed",
    error: null,
    incomplete_details: incomplete ? { reason: "max_output_tokens" } : null,
    instructions: prepared.instructions ?? null,
    max_output_tokens: prepared.maxCompletionTokens ?? null,
    model: prepared.modelId,
    output: [
      {
        id: messageId,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    parallel_tool_calls: false,
    previous_response_id: null,
    tools: [],
    temperature: prepared.body?.temperature ?? null,
    top_p: prepared.body?.top_p ?? null,
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
      total_tokens: usage.total_tokens ?? 0,
    },
  };
}

// ECO-04 P2:/responses 橋接的串流面 —— 逐個吃「已正規化的公開 chat
// chunk」(normalizeStreamChunk 的輸出),吐出 Responses SSE 事件序列
// (response.created → output_item.added → content_part.added →
// output_text.delta* → output_text.done → content_part.done →
// output_item.done → response.completed/incomplete)。狀態機由本廠
// 函式持有,端點層只負責把事件編成 SSE frame;計費仍走 chat 管線的
// finalizeStream(結算使用量以 usage chunk 為準,與事件序列解耦)。
export function createAkentrosResponsesStreamBridge(prepared: any) {
  const messageId = `msg_${prepared.requestId.slice(4)}`;
  let started = false;
  let text = "";
  let finishReason: string | null = null;
  let usage: any = null;

  function responseSkeleton(status: string) {
    return {
      id: `resp_${prepared.requestId.slice(4)}`,
      object: "response",
      created_at: prepared.created,
      status,
      error: null,
      incomplete_details: null,
      instructions: prepared.instructions ?? null,
      max_output_tokens: prepared.maxCompletionTokens ?? null,
      model: prepared.modelId,
      output: [],
      parallel_tool_calls: false,
      previous_response_id: null,
      tools: [],
      temperature: prepared.body?.temperature ?? null,
      top_p: prepared.body?.top_p ?? null,
      ...(usage
        ? {
            usage: {
              input_tokens: usage.prompt_tokens ?? 0,
              output_tokens: usage.completion_tokens ?? 0,
              total_tokens: usage.total_tokens ?? 0,
            },
          }
        : {}),
    };
  }

  function openingEvents(): Array<{ event: string; data: any }> {
    return [
      {
        event: "response.created",
        data: { type: "response.created", sequence_number: 0, response: responseSkeleton("in_progress") },
      },
      {
        event: "response.output_item.added",
        data: {
          type: "response.output_item.added",
          sequence_number: 1,
          output_index: 0,
          item: { id: messageId, type: "message", status: "in_progress", role: "assistant", content: [] },
        },
      },
      {
        event: "response.content_part.added",
        data: {
          type: "response.content_part.added",
          sequence_number: 2,
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        },
      },
    ];
  }

  return {
    translate(chunk: any): Array<{ event: string; data: any }> {
      const events: Array<{ event: string; data: any }> = [];
      if (!started) {
        started = true;
        events.push(...openingEvents());
      }
      if (chunk?.usage) usage = chunk.usage;
      for (const choice of Array.isArray(chunk?.choices) ? chunk.choices : []) {
        const delta = choice?.delta || {};
        if (typeof delta.content === "string" && delta.content) {
          text += delta.content;
          events.push({
            event: "response.output_text.delta",
            data: {
              type: "response.output_text.delta",
              item_id: messageId,
              output_index: 0,
              content_index: 0,
              delta: delta.content,
            },
          });
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason;
      }
      return events;
    },
    finalize(): Array<{ event: string; data: any }> {
      const opening: Array<{ event: string; data: any }> = [];
      if (!started) {
        started = true;
        opening.push(...openingEvents());
      }
      const incomplete = finishReason === "length";
      const finalResponse = {
        ...responseSkeleton(incomplete ? "incomplete" : "completed"),
        incomplete_details: incomplete ? { reason: "max_output_tokens" } : null,
        output: [
          {
            id: messageId,
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text, annotations: [] }],
          },
        ],
      };
      return [
        ...opening,
        {
          event: "response.output_text.done",
          data: {
            type: "response.output_text.done",
            item_id: messageId,
            output_index: 0,
            content_index: 0,
            text,
          },
        },
        {
          event: "response.content_part.done",
          data: {
            type: "response.content_part.done",
            item_id: messageId,
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text, annotations: [] },
          },
        },
        {
          event: "response.output_item.done",
          data: {
            type: "response.output_item.done",
            output_index: 0,
            item: {
              id: messageId,
              type: "message",
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text, annotations: [] }],
            },
          },
        },
        {
          event: incomplete ? "response.incomplete" : "response.completed",
          data: {
            type: incomplete ? "response.incomplete" : "response.completed",
            response: finalResponse,
          },
        },
      ];
    },
  };
}

// 公開 embeddings 回應的 usage:僅 prompt_tokens/total_tokens(OpenAI embeddings
// 慣例);provider 缺 usage 時以保留時的輸入估計回補,輸出恆為 0。
function publicEmbeddingsUsage(usage: any, fallback: any = {}) {
  const normalized = normalizeProviderUsage(usage);
  if (normalized) {
    return { prompt_tokens: normalized.prompt_tokens, total_tokens: normalized.total_tokens };
  }
  const promptTokens = tokenCount(usage?.prompt_tokens, tokenCount(fallback.inputTokens));
  return { prompt_tokens: promptTokens, total_tokens: tokenCount(usage?.total_tokens, promptTokens) };
}

function publicEmbeddings(result: any, prepared: any) {
  const data = Array.isArray(result.payload.data) ? result.payload.data : [];
  return {
    object: "list",
    data: data.map((item: any, index: number) => ({
      object: "embedding",
      index:
        Number.isSafeInteger(Number(item?.index)) && Number(item.index) >= 0 ? Number(item.index) : index,
      embedding: item?.embedding,
    })),
    model: prepared.modelId,
    usage: publicEmbeddingsUsage(result.payload.usage, result),
  };
}

// 成功回應但 provider 未回報合法 usage 時的保守估計結算:不再進入隔離佇列
// 等待一小時後全額退款(平台吸收成本),改以「保留時的輸入估計 + 實際輸出
// 長度」計費並標記 usage_source='estimated'。settle 的 SQL 以
// MIN(CAST(actual AS INTEGER), reserved) 夾制,估計永不超過原保留額,
// 維持絕不多收立場。
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

// 推論 runtime 的組裝契約:billing/attempts/claim/release 由宿主(gateway、
// 測試)注入,core 只定義介面,不依賴宿主型別。過去此邊界整個是 any,
// 計費呼叫的形狀錯誤只能在執行期被發現;現在由編譯期檢查。
export interface AkentrosInferenceRuntimeOptions {
  billing: AkentrosBillableBilling;
  attempts?: AkentrosAttemptAuditor | null;
  claimCredential: (
    route: unknown,
    requestId: string,
    excludedCredentialIds: string[],
  ) => Promise<AkentrosCredentialClaim | null | undefined>;
  releaseCredential: (claim: AkentrosCredentialClaim, outcome: unknown) => Promise<unknown>;
  fetchImpl?: typeof fetch;
  cloudflareAiBinding?: unknown;
}

export function createAkentrosInferenceRuntime({
  billing,
  attempts = null,
  claimCredential,
  releaseCredential,
  fetchImpl = globalThis.fetch,
  cloudflareAiBinding = null,
}: AkentrosInferenceRuntimeOptions) {
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
    // 成本。FN-5 fix:首次 attempt 不再豁免——config 驗證層已保證
    // timeout_ms ≤ 240s(240+15s 緩衝 < 300s TTL),正常設定下首次 attempt
    // 必然在期限前完成;若部署端繞過驗證塞入超長 timeout,此處直接
    // 停止派發(503)也遠比結算被對帳搶先(隔離一小時)安全。
    const reservationDeadlineMs = Date.parse(prepared?.reservation?.expiresAt || "");
    const SETTLEMENT_BUFFER_MS = 15_000;
    for (const route of prepared.routes) {
      const routeTimeoutMs = Number(route?.timeout_ms) > 0 ? Number(route.timeout_ms) : 60_000;
      const attemptedCredentialIds = new Set<string>();
      while (attemptNumber < MAX_PROVIDER_ATTEMPTS) {
        if (
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
        let attempt: Awaited<ReturnType<AkentrosAttemptAuditor["start"]>> = null;
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
            throw new AkentrosProviderError("Provider attempt audit is unavailable.", {
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
            throw new AkentrosProviderError("Provider attempt audit is unavailable.", {
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
            endpoint: prepared.endpoint,
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
          if (!(error instanceof AkentrosProviderError) || !error.fallbackAllowed || error.responseStarted)
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
      new AkentrosProviderError("No provider capacity is available.", {
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
        throw new AkentrosError("Akentros returned an unexpected response.", {
          status: 503,
          type: "server_error",
          code: "service_unavailable",
          retryAfter: 5,
        });
      }
      if (invocation.result.usageSource !== "provider") {
        // 成功回應但缺合法 usage(如 Cloudflare legacy shape 一律 estimated):
        // 以保守估計結算,不再標記待核對(隔離一小時後全額退款)。
        // embeddings 無輸出 token,缺 usage 時僅按輸入估計結算。
        const inputTokens = Number(prepared.estimatedInputTokens) || 0;
        const outputTokens =
          prepared.endpoint === "embeddings"
            ? 0
            : cappedEstimatedOutputTokens(prepared, completionPayloadOutputChars(invocation.result.payload));
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
      const body: any =
        prepared.endpoint === "embeddings"
          ? publicEmbeddings(invocation.result, prepared)
          : publicCompletion(invocation.result, prepared);
      return {
        requestId: prepared.requestId,
        pricingRevision: BACKEND_PRICING.revision,
        body,
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
        throw new AkentrosError("Akentros returned an unexpected response.", {
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
    throw new AkentrosProviderError("The provider emitted an invalid SSE payload.", {
      provider: "unknown",
      category: "invalid_provider_response",
      responseStarted: true,
      usageUnknown: true,
    });
  if (payload.error)
    throw new AkentrosProviderError("The provider failed after streaming started.", {
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
  throw new AkentrosProviderError("The provider emitted an unsupported SSE payload.", {
    provider: "unknown",
    category: "invalid_provider_response",
    responseStarted: true,
    usageUnknown: true,
  });
}
