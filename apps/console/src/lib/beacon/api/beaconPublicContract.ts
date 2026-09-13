import type {
  BeaconLogsPage,
  BeaconPublicErrorCode,
  BeaconRequestDetail,
  BeaconRequestStatus,
  BeaconStreamChoice,
  BeaconStreamChunk,
  BeaconUsageLog,
  BeaconUsageSummary,
} from "../types";

type BeaconErrorContext = "developer" | "inference" | "stream";

interface NormalizeErrorOptions {
  status?: number;
  context?: BeaconErrorContext;
  fallbackCode?: BeaconPublicErrorCode;
}

export interface NormalizedBeaconError {
  code: BeaconPublicErrorCode;
  message: string;
}

const ERROR_MESSAGES = Object.freeze({
  invalid_request: "Beacon 請求內容無效，請檢查後再試。",
  unsupported_parameter: "請求包含 Beacon 不支援的參數。",
  unsupported_feature: "指定的 Beacon 功能目前不受支援。",
  invalid_api_key: "Beacon API 金鑰無效或已失效。",
  authentication_required: "請先登入以使用 Beacon。",
  insufficient_scope: "此 API 金鑰尚未取得所需的 Beacon 權限。",
  access_denied: "目前無法使用此 Beacon 功能。",
  model_not_found: "找不到指定的 Beacon 模型。",
  model_not_allowed: "此 API 金鑰未開放指定的 Beacon 模型。",
  spend_limit_exceeded: "此 API 金鑰已達消費上限。",
  insufficient_balance: "Beacon 餘額不足，無法完成此請求。",
  free_quota_exceeded: "此 Beacon 免費額度已用完。",
  rate_limit_exceeded: "Beacon 請求過於頻繁，請稍後再試。",
  max_in_flight_exceeded: "同時進行的 Beacon 請求已達上限，請稍後再試。",
  request_cancelled: "Beacon 請求已取消。",
  service_unavailable: "Beacon 暫時無法完成此請求，請稍後再試。",
  request_failed: "Beacon 無法完成此請求，請稍後再試。",
  not_found: "找不到指定的 Beacon 資料。",
  conflict: "Beacon 無法套用此項變更，請重新整理後再試。",
  connection_error: "目前無法連線至 Beacon，請稍後再試。",
  invalid_response: "Beacon 傳回了無法處理的回應。",
  invalid_stream_payload: "Beacon 傳回了無法解析的串流資料。",
  invalid_stream_response: "Beacon 未傳回有效的串流資料。",
  stream_interrupted: "Beacon 串流已中斷，請稍後再試。",
  stream_truncated: "Beacon 串流在完成前中斷。",
  AI_KEY_LIMIT: "Beacon 金鑰數量已達上限。",
  INVALID_AI_KEY_OPTIONS: "Beacon 金鑰設定無效。",
  AI_KEY_UNAVAILABLE: "Beacon 金鑰管理暫時無法使用。",
  INVALID_AI_KEY_ID: "Beacon 金鑰識別碼無效。",
  AI_KEY_NOT_FOUND: "找不到指定的 Beacon 金鑰。",
  INVALID_AI_USAGE_QUERY: "Beacon 用量查詢條件無效。",
  AI_USAGE_UNAVAILABLE: "Beacon 用量資料暫時無法使用。",
  USER_NOT_FOUND: "找不到 Beacon 帳號資料。",
  AI_REQUEST_NOT_FOUND: "找不到指定的 Beacon 請求。",
} satisfies Record<BeaconPublicErrorCode, string>);

const REQUEST_STATUSES = new Set<BeaconRequestStatus>([
  "pending_reservation",
  "reserved",
  "dispatched",
  "succeeded",
  "partially_succeeded",
  "rejected",
  "refunded",
  "needs_reconciliation",
]);

const FINISH_REASONS = new Set(["stop", "length", "content_filter"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key);
}

function knownErrorCode(value: unknown): BeaconPublicErrorCode | null {
  if (typeof value !== "string") return null;
  const code = value.trim();
  if (!code || code.length > 100) return null;
  if (hasOwn(ERROR_MESSAGES, code)) return code as BeaconPublicErrorCode;

  return null;
}

function payloadErrorCode(payload: unknown): unknown {
  if (!isRecord(payload)) return null;
  if (isRecord(payload.error)) return payload.error.code;
  return payload.code;
}

function statusErrorCode(status: number, context: BeaconErrorContext): BeaconPublicErrorCode {
  if (status === 400 || status === 422) return "invalid_request";
  if (status === 401) {
    return context === "developer" ? "authentication_required" : "invalid_api_key";
  }
  if (status === 402) return "insufficient_balance";
  if (status === 403) {
    return context === "developer" ? "access_denied" : "service_unavailable";
  }
  if (status === 404) return context === "developer" ? "not_found" : "model_not_found";
  if (status === 408) return "request_cancelled";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limit_exceeded";
  if (status >= 500) return "service_unavailable";
  return "request_failed";
}

export function normalizeBeaconError(
  payload: unknown,
  options: NormalizeErrorOptions = {},
): NormalizedBeaconError {
  const status = Number.isInteger(options.status) ? Number(options.status) : 0;
  const context = options.context ?? "inference";
  const code =
    knownErrorCode(payloadErrorCode(payload)) ?? options.fallbackCode ?? statusErrorCode(status, context);
  return { code, message: ERROR_MESSAGES[code] };
}

export function normalizeBeaconUsageErrorCode(value: unknown): BeaconPublicErrorCode | null {
  if (value === null || value === undefined || value === "") return null;
  return knownErrorCode(value) ?? "request_failed";
}

export function hasBeaconErrorEnvelope(payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  if (hasOwn(payload, "error") && payload.error !== null && payload.error !== undefined) {
    return true;
  }
  return typeof payload.message === "string" && hasOwn(payload, "code");
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function requestStatus(value: unknown): BeaconRequestStatus {
  return typeof value === "string" && REQUEST_STATUSES.has(value as BeaconRequestStatus)
    ? (value as BeaconRequestStatus)
    : "rejected";
}

function normalizeUsageLog(value: unknown): BeaconUsageLog {
  const record = isRecord(value) ? value : {};
  const requestedModel = text(record.requested_model);
  return {
    request_id: text(record.request_id),
    created_at: text(record.created_at),
    api_key_id: nullableText(record.api_key_id),
    key_name: nullableText(record.key_name),
    requested_model: requestedModel,
    actual_model: requestedModel,
    provider: "beacon",
    status: requestStatus(record.status),
    input_tokens: number(record.input_tokens),
    output_tokens: number(record.output_tokens),
    total_tokens: number(record.total_tokens),
    reserved_usd: String(number(record.reserved_usd)),
    charged_usd: String(number(record.charged_usd)),
    refunded_usd: String(number(record.refunded_usd)),
    latency_ms: nullableNumber(record.latency_ms),
    error_code: normalizeBeaconUsageErrorCode(record.error_code),
  };
}

export function normalizeBeaconUsageSummary(value: unknown): BeaconUsageSummary {
  const record = isRecord(value) ? value : {};
  const freeModelQuotas = isRecord(record.free_model_quotas) ? record.free_model_quotas : {};
  const normalizedFreeModelQuotas = Object.fromEntries(
    Object.entries(freeModelQuotas).flatMap(([modelId, quota]) => {
      if (!isRecord(quota)) return [];
      return [[modelId, { used: number(quota.used), limit: number(quota.limit) }]];
    }),
  );
  return {
    balance_usd: String(number(record.balance_usd)),
    requests: number(record.requests),
    succeeded: number(record.succeeded),
    failed: number(record.failed),
    input_tokens: number(record.input_tokens),
    output_tokens: number(record.output_tokens),
    total_tokens: number(record.total_tokens),
    charged_usd: String(number(record.charged_usd)),
    period_days: number(record.period_days),
    free_model_quotas: normalizedFreeModelQuotas,
  };
}

export function normalizeBeaconLogsPage(value: unknown): BeaconLogsPage {
  const record = isRecord(value) ? value : {};
  const pagination = isRecord(record.pagination) ? record.pagination : {};
  return {
    logs: Array.isArray(record.logs) ? record.logs.map(normalizeUsageLog) : [],
    pagination: {
      next_cursor: nullableText(pagination.next_cursor),
      has_more: pagination.has_more === true,
    },
  };
}

export function normalizeBeaconRequestDetail(value: unknown): BeaconRequestDetail {
  const record = isRecord(value) ? value : {};
  return {
    ...normalizeUsageLog(record),
    completed_at: nullableText(record.completed_at),
    pricing_revision: nullableText(record.pricing_revision),
    fallback_count: 0,
    first_token_latency_ms: nullableNumber(record.first_token_latency_ms),
  };
}

function normalizeStreamChoice(value: unknown, fallbackIndex: number): BeaconStreamChoice | null {
  if (!isRecord(value)) return null;
  const delta = isRecord(value.delta) ? value.delta : {};
  const index = Number(value.index);
  const finishReason: BeaconStreamChoice["finish_reason"] =
    typeof value.finish_reason === "string"
      ? FINISH_REASONS.has(value.finish_reason)
        ? (value.finish_reason as Exclude<BeaconStreamChoice["finish_reason"], null>)
        : "stop"
      : null;
  return {
    index: Number.isSafeInteger(index) && index >= 0 ? index : fallbackIndex,
    delta: {
      ...(delta.role === "assistant" ? { role: "assistant" } : {}),
      ...(typeof delta.content === "string" || delta.content === null ? { content: delta.content } : {}),
      ...(typeof delta.reasoning === "string" || delta.reasoning === null
        ? { reasoning: delta.reasoning }
        : {}),
      ...(typeof delta.reasoning_content === "string" || delta.reasoning_content === null
        ? { reasoning_content: delta.reasoning_content }
        : {}),
    },
    finish_reason: finishReason,
  };
}

export function normalizeBeaconStreamChunk(value: unknown): BeaconStreamChunk {
  const record = isRecord(value) ? value : {};
  const choices = Array.isArray(record.choices)
    ? record.choices
        .map(normalizeStreamChoice)
        .filter((choice): choice is BeaconStreamChoice => choice !== null)
    : [];
  const usageRecord = isRecord(record.usage) ? record.usage : null;
  const promptTokens = nullableNumber(usageRecord?.prompt_tokens);
  const completionTokens = nullableNumber(usageRecord?.completion_tokens);
  const totalTokens = nullableNumber(usageRecord?.total_tokens);
  const details = isRecord(usageRecord?.completion_tokens_details)
    ? usageRecord.completion_tokens_details
    : null;
  const reasoningTokens = details?.reasoning_tokens;
  const reasoningDetails =
    typeof reasoningTokens === "number" &&
    Number.isSafeInteger(reasoningTokens) &&
    reasoningTokens >= 0 &&
    completionTokens !== null &&
    reasoningTokens <= completionTokens
      ? { reasoning_tokens: reasoningTokens }
      : null;
  const usage =
    usageRecord && promptTokens !== null && completionTokens !== null && totalTokens !== null
      ? {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: totalTokens,
          ...(reasoningDetails ? { completion_tokens_details: reasoningDetails } : {}),
        }
      : null;
  return { choices, usage };
}
