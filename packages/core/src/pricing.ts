import pricingDocument from "../config/backend-pricing.v1.json" with { type: "json" };

const DECIMAL_INTEGER = /^(0|[1-9][0-9]*)$/;
const USD_DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/;
const MICROS_PER_USD = 1_000_000n;

function deepFreeze(value: any): any {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function toUnsignedBigInt(value: any, label: string): bigint {
  if (typeof value === "bigint") {
    if (value < 0n) throw new RangeError(`${label} must be non-negative.`);
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`${label} must be a non-negative safe integer, decimal string, or bigint.`);
    }
    return BigInt(value);
  }

  if (typeof value === "string" && DECIMAL_INTEGER.test(value)) return BigInt(value);
  throw new TypeError(`${label} must be a non-negative integer without a decimal or exponent.`);
}

// 金額一律以微美元整數(1 USD = 1,000,000 µUSD)計算,避免浮點誤差。
// 設定檔以人類可讀的美元小數字串儲存(最多 6 位),載入時以字串精確轉換。
export function parseUsdToMicros(value: any, label = "usd amount"): bigint {
  const normalized = typeof value === "number" ? value.toString() : String(value ?? "").trim();
  if (!USD_DECIMAL.test(normalized)) {
    throw new TypeError(`${label} must be a non-negative USD decimal with at most 6 fractional digits.`);
  }
  const [whole, fraction = ""] = normalized.split(".");
  const paddedFraction = (fraction + "0".repeat(6)).slice(0, 6);
  return BigInt(whole) * MICROS_PER_USD + BigInt(paddedFraction || "0");
}

export function usdMicrosToDecimalString(micros: any): string {
  const value = toUnsignedBigInt(micros, "usd micros");
  const whole = value / MICROS_PER_USD;
  const fraction = (value % MICROS_PER_USD).toString().padStart(6, "0");
  return `${whole}.${fraction}`;
}

function ceilDivide(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError("The pricing token scale must be positive.");
  if (numerator === 0n) return 0n;
  return (numerator + denominator - 1n) / denominator;
}

function toSafeMicroNumber(micros: bigint) {
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("The calculated cost exceeds Number.MAX_SAFE_INTEGER micro-USD.");
  }
  return Number(micros);
}

function resolveModel(modelOrConfig: any): any {
  if (typeof modelOrConfig === "string") return requireModelPricing(modelOrConfig);
  if (modelOrConfig && typeof modelOrConfig === "object" && modelOrConfig.billing && modelOrConfig.limits) {
    return modelOrConfig;
  }
  throw new TypeError("Expected an enabled model ID or a model pricing object.");
}

function calculateCostMicrosBigInt(model: any, inputTokens: any, outputTokens: any): bigint {
  const input = toUnsignedBigInt(inputTokens, "inputTokens");
  const output = toUnsignedBigInt(outputTokens, "outputTokens");
  const inputRate = parseUsdToMicros(
    model.billing.input_usd_per_million_tokens,
    "input_usd_per_million_tokens",
  );
  const outputRate = parseUsdToMicros(
    model.billing.output_usd_per_million_tokens,
    "output_usd_per_million_tokens",
  );
  const minimum = parseUsdToMicros(model.billing.minimum_charge_usd, "minimum_charge_usd");
  const calculated = ceilDivide(input * inputRate + output * outputRate, MICROS_PER_USD);
  return calculated < minimum ? minimum : calculated;
}

export const BACKEND_PRICING: any = deepFreeze(pricingDocument);

export function listEnabledModels(config: any = BACKEND_PRICING) {
  return Object.entries(config.models || {})
    .filter(([, model]: [string, any]) => model?.enabled === true)
    .map(([id, model]: [string, any]) => ({ id, ...model }));
}

export function getModelPricing(modelId: any, config: any = BACKEND_PRICING) {
  if (typeof modelId !== "string" || !modelId) return null;
  const model = config.models?.[modelId];
  return model?.enabled === true ? model : null;
}

export function requireModelPricing(modelId: any, config: any = BACKEND_PRICING) {
  const model = getModelPricing(modelId, config);
  if (!model) throw new RangeError(`Unknown or disabled Beacon model: ${String(modelId)}`);
  return model;
}

export function calculateActualCostMicrosBigInt(modelOrConfig: any, inputTokens: any, outputTokens: any) {
  return calculateCostMicrosBigInt(resolveModel(modelOrConfig), inputTokens, outputTokens);
}

export function calculateActualCostMicros(modelOrConfig: any, inputTokens: any, outputTokens: any) {
  return toSafeMicroNumber(calculateActualCostMicrosBigInt(modelOrConfig, inputTokens, outputTokens));
}

export function calculateReservationCostMicrosBigInt(
  modelOrConfig: any,
  inputTokens: any,
  maxOutputTokens?: any,
) {
  const model = resolveModel(modelOrConfig);
  const input = toUnsignedBigInt(inputTokens, "inputTokens");
  const output = toUnsignedBigInt(
    maxOutputTokens ?? model.limits.default_max_completion_tokens,
    "maxOutputTokens",
  );
  const maxInput = toUnsignedBigInt(model.limits.max_input_tokens, "max_input_tokens");
  const maxOutput = toUnsignedBigInt(model.limits.max_completion_tokens, "max_completion_tokens");
  const context = toUnsignedBigInt(model.limits.context_tokens, "context_tokens");

  if (input > maxInput) throw new RangeError("Estimated input tokens exceed the model input limit.");
  if (output > maxOutput) throw new RangeError("Requested output tokens exceed the model output limit.");
  if (input + output > context) throw new RangeError("Reserved tokens exceed the model context limit.");

  return calculateCostMicrosBigInt(model, input, output);
}

export function calculateReservationCostMicros(modelOrConfig: any, inputTokens: any, maxOutputTokens?: any) {
  return toSafeMicroNumber(calculateReservationCostMicrosBigInt(modelOrConfig, inputTokens, maxOutputTokens));
}

export function estimateInputTokens(body: any) {
  const serialized = typeof body === "string" ? body : (JSON.stringify(body) ?? "");
  const byteLength = new TextEncoder().encode(serialized).byteLength;
  const messageCount = Array.isArray(body?.messages) ? body.messages.length : 0;
  const overhead = 32 + messageCount * 8;
  const estimate = byteLength + overhead;
  if (!Number.isSafeInteger(estimate)) throw new RangeError("Estimated input token count is too large.");
  return estimate;
}

export function createBillingSnapshot(modelId: any, config: any = BACKEND_PRICING) {
  const model = requireModelPricing(modelId, config);
  return {
    pricing_revision: config.revision,
    model: modelId,
    currency: { ...config.currency },
    billing: { ...model.billing },
    limits: { ...model.limits },
  };
}

export function listCandidateRoutes(modelOrConfig: any) {
  return [...resolveModel(modelOrConfig).routes]
    .filter((route: any) => route.enabled === true)
    .sort(
      (left: any, right: any) =>
        left.priority - right.priority || left.route_id.localeCompare(right.route_id),
    );
}
