import { apiFetch, getExternalDeveloperApiBase } from "../../../services/api";
import type {
  AkentrosApiKey,
  AkentrosKeyCreateOptions,
  AkentrosKeyMutationResult,
  AkentrosLogsPage,
  AkentrosLogsQuery,
  AkentrosPublicErrorCode,
  AkentrosRequestDetail,
  AkentrosUsageSummary,
} from "../types";
import {
  normalizeAkentrosError,
  normalizeAkentrosLogsPage,
  normalizeAkentrosRequestDetail,
  normalizeAkentrosUsageSummary,
} from "./akentrosPublicContract";

const DEVELOPER_ROOT = "/ai/developer";

export class AkentrosApiError extends Error {
  readonly status: number;
  readonly code: AkentrosPublicErrorCode | null;

  constructor(message: string, status: number, code: AkentrosPublicErrorCode | null = null) {
    super(message);
    this.name = "AkentrosApiError";
    this.status = status;
    this.code = code;
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  let payload: unknown = null;

  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const error = normalizeAkentrosError(payload, {
      status: response.status,
      context: "developer",
    });
    throw new AkentrosApiError(error.message, response.status, error.code);
  }

  if (payload === null) {
    const error = normalizeAkentrosError(null, { fallbackCode: "invalid_response" });
    throw new AkentrosApiError(error.message, response.status, error.code);
  }

  return payload as T;
}

function isAbortError(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "name" in cause && cause.name === "AbortError";
}

async function developerFetch(path: string, init: RequestInit): Promise<Response> {
  try {
    return await apiFetch(`${DEVELOPER_ROOT}${path}`, init);
  } catch (cause) {
    if (init.signal?.aborted || isAbortError(cause)) throw cause;
    const error = normalizeAkentrosError(null, { fallbackCode: "connection_error" });
    throw new AkentrosApiError(error.message, 0, error.code);
  }
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await developerFetch(path, {
    ...init,
    headers,
  });
  return readJson<T>(response);
}

export function getAkentrosPublicApiRoot(): string {
  const base = getExternalDeveloperApiBase()
    .replace(/\/$/, "")
    .replace(/\/api$/, "");
  return `${base}/api/ai/v1`;
}

export function getAkentrosChatCompletionsUrl(): string {
  return `${getAkentrosPublicApiRoot()}/chat/completions`;
}

export function getAkentrosAccountChatCompletionsPath(): string {
  return `${DEVELOPER_ROOT}/chat/completions`;
}

export async function listAkentrosKeys(signal?: AbortSignal): Promise<AkentrosApiKey[]> {
  const payload = await requestJson<{ keys: AkentrosApiKey[] }>("/keys", { signal });
  return payload.keys;
}

export async function createAkentrosKey(options: AkentrosKeyCreateOptions): Promise<AkentrosKeyMutationResult> {
  return requestJson<AkentrosKeyMutationResult>("/keys", {
    method: "POST",
    body: JSON.stringify(options),
  });
}

export async function rotateAkentrosKey(id: string): Promise<AkentrosKeyMutationResult> {
  return requestJson<AkentrosKeyMutationResult>(`/keys/${encodeURIComponent(id)}/rotate`, {
    method: "POST",
  });
}

export async function revokeAkentrosKey(id: string): Promise<void> {
  const response = await developerFetch(`/keys/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    await readJson<never>(response);
  }
}

export async function getAkentrosUsageSummary(signal?: AbortSignal): Promise<AkentrosUsageSummary> {
  const payload = await requestJson<{ usage: AkentrosUsageSummary }>("/usage/summary", { signal });
  return normalizeAkentrosUsageSummary(payload?.usage);
}

export async function listAkentrosLogs(query: AkentrosLogsQuery, signal?: AbortSignal): Promise<AkentrosLogsPage> {
  const params = new URLSearchParams();
  if (query.cursor) params.set("cursor", query.cursor);
  if (query.limit) params.set("limit", String(query.limit));
  if (query.model) params.set("model", query.model);
  if (query.status) params.set("status", query.status);
  if (query.from) params.set("from", query.from);
  if (query.to) params.set("to", query.to);
  const suffix = params.size ? `?${params.toString()}` : "";
  const payload = await requestJson<unknown>(`/logs${suffix}`, { signal });
  return normalizeAkentrosLogsPage(payload);
}

export async function getAkentrosRequestDetail(
  requestId: string,
  signal?: AbortSignal,
): Promise<AkentrosRequestDetail> {
  const payload = await requestJson<unknown>(`/requests/${encodeURIComponent(requestId)}`, { signal });
  return normalizeAkentrosRequestDetail(payload);
}
