import { parseUsdToMicros, usdMicrosToDecimalString } from "./pricing.ts";

const AKENTROS_API_KEY_PATTERN = /^sk-akentros-(live|test)_[A-Za-z0-9_-]{40,}$/;
export const AKENTROS_DEFAULT_SCOPES = Object.freeze(["chat:completions", "models:read"]);
export const AKENTROS_MAX_ACTIVE_KEYS = 10;
export const AKENTROS_MIN_KEY_TTL_MS = 60 * 60 * 1000;

const MAX_BIGINT_ID = 9_223_372_036_854_775_807n;
const ALLOWED_OPTION_KEYS = new Set([
  "name",
  "environment",
  "model_allowlist",
  "rpm_limit",
  "max_in_flight",
  "spend_limit_usd",
  "expires_at",
]);
const AI_SERVICE_ALIASES = new Set(["/developer", "/developer/ai-api", "#ai-api"]);

function optionError(message: string, code = "INVALID_AI_KEY_CONFIGURATION") {
  const error = new TypeError(message) as TypeError & { code?: string };
  error.code = code;
  return error;
}

export function parseAkentrosJsonArray(value: any): any[] {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// 嚴格版的 model_allowlist 解析:此欄位一律由本系統寫入(必為合法 JSON 陣列),
// 解析失敗代表資料列損毀。回傳 null 讓呼叫端 fail-closed(拒絕該金鑰);
// 若使用 parseAkentrosJsonArray 會得到 [] = 「不限制任何模型」,形同損毀
// 靜默解除金鑰的模型限制。
export function parseAkentrosModelAllowlistStrict(value: any): string[] | null {
  if (value == null || value === "") return [];
  let parsed: any = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(parsed)) return null;
  if (!parsed.every((item: any) => typeof item === "string" && item.trim())) return null;
  return parsed.map((item: any) => item.trim()).filter(Boolean);
}

function normalizeTimestamp(value: any): string | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function optionalBoundedInteger(
  value: any,
  label: string,
  { minimum, maximum, fallback = null }: { minimum: number; maximum: number; fallback?: number | null },
): number | null {
  if (value == null || value === "") return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw optionError(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

export function requireAkentrosApiKeyPepper(value: any) {
  const pepper = String(value || "");
  if (new TextEncoder().encode(pepper).byteLength < 32) {
    const error = new Error("AKENTROS_API_KEY_PEPPER must contain at least 32 bytes.") as Error & {
      code?: string;
    };
    error.code = "AKENTROS_API_KEY_PEPPER_INVALID";
    throw error;
  }
  return pepper;
}

export function isAkentrosApiKey(value: any) {
  return AKENTROS_API_KEY_PATTERN.test(String(value || ""));
}

export function maskAkentrosApiKey(value: any) {
  const secret = String(value || "");
  return {
    // 僅保留固定的環境前綴(sk-akentros-live_ / sk-akentros-test_,13 字)+ 4 個
    // 秘密字元,足以辨識金鑰;再長就會不必要地洩漏 token 前段。
    key_prefix: secret.slice(0, 17),
    key_suffix: secret.slice(-4),
  };
}

export function normalizeAkentrosKeyOptions(options: any, enabledModelIds: string[] = []) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw optionError("The request body must be a JSON object.");
  }

  for (const key of Object.keys(options)) {
    if (!ALLOWED_OPTION_KEYS.has(key)) {
      throw optionError(`Unsupported Akentros key option: ${key}.`);
    }
  }

  const name = String(options.name || "").trim();
  if (!name || name.length > 80) {
    throw optionError("Key name must contain 1 to 80 characters.");
  }

  const environment = options.environment ?? "live";
  if (environment !== "live" && environment !== "test") {
    throw optionError("environment must be either live or test.");
  }

  const modelAllowlist = options.model_allowlist ?? [];
  if (!Array.isArray(modelAllowlist) || modelAllowlist.length > 100) {
    throw optionError("model_allowlist must be an array with at most 100 model IDs.");
  }
  if (modelAllowlist.length > 0 && (!Array.isArray(enabledModelIds) || enabledModelIds.length === 0)) {
    // 指定了白名單卻沒有可用的模型目錄 = 設定錯誤;此時略過驗證會讓任意
    // (可能已停用)模型 id 進入白名單,因此明確拒絕。
    throw optionError("The Akentros model catalog is unavailable; model_allowlist cannot be validated.");
  }
  const enabledModels = new Set(enabledModelIds);
  const normalizedAllowlist: string[] = [];
  for (const rawModelId of modelAllowlist) {
    if (typeof rawModelId !== "string" || !rawModelId.trim()) {
      throw optionError("model_allowlist entries must be non-empty strings.");
    }
    const modelId = rawModelId.trim();
    if (enabledModels.size > 0 && !enabledModels.has(modelId)) {
      throw optionError(`Unknown or disabled Akentros model: ${modelId}.`);
    }
    if (!normalizedAllowlist.includes(modelId)) normalizedAllowlist.push(modelId);
  }

  const rpmLimit = optionalBoundedInteger(options.rpm_limit, "rpm_limit", {
    minimum: 1,
    maximum: 6000,
    fallback: 60,
  });
  const maxInFlight = optionalBoundedInteger(options.max_in_flight, "max_in_flight", {
    minimum: 1,
    maximum: 100,
    fallback: 4,
  });
  let spendLimitUsdMicros: number | null = null;
  if (options.spend_limit_usd != null && options.spend_limit_usd !== "") {
    const micros = parseUsdToMicros(options.spend_limit_usd, "spend_limit_usd");
    if (micros > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw optionError("spend_limit_usd exceeds the supported range.");
    }
    spendLimitUsdMicros = Number(micros);
  }

  let expiresAt: string | null = null;
  if (options.expires_at != null && options.expires_at !== "") {
    const parsedExpiry = new Date(options.expires_at);
    if (Number.isNaN(parsedExpiry.getTime())) {
      throw optionError("expires_at must be an RFC 3339 date-time.");
    }
    if (parsedExpiry.getTime() < Date.now() + AKENTROS_MIN_KEY_TTL_MS) {
      throw optionError("expires_at must be at least 1 hour in the future.");
    }
    expiresAt = parsedExpiry.toISOString();
  }

  return {
    name,
    environment,
    modelAllowlist: normalizedAllowlist,
    rpmLimit,
    maxInFlight,
    spendLimitUsdMicros,
    expiresAt,
  };
}

export function parseAkentrosKeyId(value: any) {
  const raw = String(value || "");
  if (!/^[1-9][0-9]*$/.test(raw)) return null;
  const parsed = BigInt(raw);
  return parsed <= MAX_BIGINT_ID ? parsed.toString() : null;
}

export function serializeAkentrosApiKey(row: any) {
  if (!row) return null;
  const keyPrefix = String(row.key_prefix ?? row.prefix ?? "");
  const keySuffix = String(row.key_suffix ?? row.suffix ?? "");
  return {
    id: String(row.id),
    name: String(row.name || ""),
    environment: row.environment === "test" ? "test" : "live",
    key_prefix: keyPrefix,
    key_suffix: keySuffix,
    masked_key: `${keyPrefix}...${keySuffix}`,
    scopes: parseAkentrosJsonArray(row.scopes),
    model_allowlist: parseAkentrosJsonArray(row.model_allowlist),
    rpm_limit: Number(row.rpm_limit),
    max_in_flight: Number(row.max_in_flight),
    spend_limit_usd:
      row.spend_limit_usd_micros == null ? null : usdMicrosToDecimalString(row.spend_limit_usd_micros),
    spend_used_usd: usdMicrosToDecimalString(row.spend_used_usd_micros || 0),
    is_active: Boolean(row.is_active),
    expires_at: normalizeTimestamp(row.expires_at),
    last_used_at: normalizeTimestamp(row.last_used_at),
    rotated_at: normalizeTimestamp(row.rotated_at),
    revoked_at: normalizeTimestamp(row.revoked_at),
    created_at: normalizeTimestamp(row.created_at),
  };
}

export function isAkentrosServiceRestricted(user: any) {
  if (!user?.is_flagged) return false;
  const restrictions = parseAkentrosJsonArray(user.restricted_services);
  return restrictions.some((item: any) => AI_SERVICE_ALIASES.has(String(item).trim().toLowerCase()));
}
