import { cors } from "hono/cors";
import { DEFAULT_ALLOWED_ORIGINS } from "../constants.ts";
import type { BeaconContext, BeaconRuntimeEnv } from "../types.ts";

function trimTrailingSlash(value: unknown) {
  return String(value || "").replace(/\/+$/, "");
}

function getAllowedOrigins(env: BeaconRuntimeEnv = {}) {
  const configuredOrigins = String(env.FRONTEND_ORIGINS || "")
    .split(",")
    .map((origin) => trimTrailingSlash(origin.trim()))
    .filter(Boolean);

  const inferredOrigins = [env.FRONTEND_BASE_URL, env.PUBLIC_BASE_URL, env.OAUTH_PUBLIC_BASE_URL]
    .map(trimTrailingSlash)
    .filter(Boolean);

  return new Set([...DEFAULT_ALLOWED_ORIGINS, ...configuredOrigins, ...inferredOrigins]);
}

function isLocalHostname(hostname: unknown) {
  const normalized = String(hostname || "")
    .toLowerCase()
    .replace(/\.$/, "");
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized) ||
    normalized === "[::1]"
  );
}

function isLocalDevelopmentRequest(c: BeaconContext) {
  try {
    return (
      isLocalHostname(new URL(c.req.url).hostname) ||
      String(c.env?.ENVIRONMENT || "").toLowerCase() === "development"
    );
  } catch {
    return false;
  }
}

function isLocalDevelopmentOrigin(value: unknown) {
  try {
    const url = new URL(trimTrailingSlash(value));
    return ["http:", "https:"].includes(url.protocol) && isLocalHostname(url.hostname);
  } catch {
    return false;
  }
}

export function isCredentialedOriginAllowed(c: BeaconContext, origin: unknown) {
  const normalized = trimTrailingSlash(origin);
  if (isLocalDevelopmentOrigin(normalized)) {
    return isLocalDevelopmentRequest(c);
  }
  if (getAllowedOrigins(c?.env).has(normalized)) return true;
  return false;
}

// 公開推理端點的額外放行來源(例如你的 API 遊樂場、文件站),
// 以逗號分隔的 BEACON_PUBLIC_ORIGINS 環境變數設定。
function getBeaconPublicOrigins(env: BeaconRuntimeEnv = {}): Set<string> {
  return new Set(
    String(env.BEACON_PUBLIC_ORIGINS || "")
      .split(",")
      .map((origin) => trimTrailingSlash(origin.trim()))
      .filter(Boolean),
  );
}

export function createCorsMiddleware() {
  return cors({
    origin: (origin, c) => {
      if (!origin) {
        return null;
      }

      return isCredentialedOriginAllowed(c, origin) ? origin : null;
    },
    credentials: true,
    allowHeaders: ["Content-Type", "Authorization", "X-CSRF-Token", "Accept", "Origin", "Idempotency-Key"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
  });
}

export function createBeaconPublicCorsMiddleware() {
  return cors({
    origin: (origin, c) => {
      if (!origin) return null;
      return isCredentialedOriginAllowed(c, origin) ||
        getBeaconPublicOrigins(c?.env).has(trimTrailingSlash(origin))
        ? origin
        : null;
    },
    credentials: false,
    allowHeaders: ["Content-Type", "Authorization", "Accept", "Origin", "Idempotency-Key"],
    allowMethods: ["GET", "POST", "OPTIONS"],
  });
}
