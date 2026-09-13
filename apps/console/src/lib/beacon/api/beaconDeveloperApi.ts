import { apiFetch, getExternalDeveloperApiBase } from "../../../services/api";
import type {
  BeaconApiKey,
  BeaconKeyCreateOptions,
  BeaconKeyMutationResult,
  BeaconLogsPage,
  BeaconLogsQuery,
  BeaconPublicErrorCode,
  BeaconRequestDetail,
  BeaconUsageSummary,
} from "../types";
import {
  normalizeBeaconError,
  normalizeBeaconLogsPage,
  normalizeBeaconRequestDetail,
  normalizeBeaconUsageSummary,
} from "./beaconPublicContract";

const DEVELOPER_ROOT = "/ai/developer";

export class BeaconApiError extends Error {
  readonly status: number;
  readonly code: BeaconPublicErrorCode | null;

  constructor(message: string, status: number, code: BeaconPublicErrorCode | null = null) {
    super(message);
    this.name = "BeaconApiError";
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
    const error = normalizeBeaconError(payload, {
      status: response.status,
      context: "developer",
    });
    throw new BeaconApiError(error.message, response.status, error.code);
  }

  if (payload === null) {
    const error = normalizeBeaconError(null, { fallbackCode: "invalid_response" });
    throw new BeaconApiError(error.message, response.status, error.code);
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
    const error = normalizeBeaconError(null, { fallbackCode: "connection_error" });
    throw new BeaconApiError(error.message, 0, error.code);
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

export function getBeaconPublicApiRoot(): string {
  const base = getExternalDeveloperApiBase()
    .replace(/\/$/, "")
    .replace(/\/api$/, "");
  return `${base}/api/ai/v1`;
}

export function getBeaconChatCompletionsUrl(): string {
  return `${getBeaconPublicApiRoot()}/chat/completions`;
}

export function getBeaconAccountChatCompletionsPath(): string {
  return `${DEVELOPER_ROOT}/chat/completions`;
}

export async function listBeaconKeys(signal?: AbortSignal): Promise<BeaconApiKey[]> {
  const payload = await requestJson<{ keys: BeaconApiKey[] }>("/keys", { signal });
  return payload.keys;
}

export async function createBeaconKey(options: BeaconKeyCreateOptions): Promise<BeaconKeyMutationResult> {
  return requestJson<BeaconKeyMutationResult>("/keys", {
    method: "POST",
    body: JSON.stringify(options),
  });
}

export async function rotateBeaconKey(id: string): Promise<BeaconKeyMutationResult> {
  return requestJson<BeaconKeyMutationResult>(`/keys/${encodeURIComponent(id)}/rotate`, {
    method: "POST",
  });
}

export async function revokeBeaconKey(id: string): Promise<void> {
  const response = await developerFetch(`/keys/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    await readJson<never>(response);
  }
}

export async function getBeaconUsageSummary(signal?: AbortSignal): Promise<BeaconUsageSummary> {
  const payload = await requestJson<{ usage: BeaconUsageSummary }>("/usage/summary", { signal });
  return normalizeBeaconUsageSummary(payload?.usage);
}

export async function listBeaconLogs(query: BeaconLogsQuery, signal?: AbortSignal): Promise<BeaconLogsPage> {
  const params = new URLSearchParams();
  if (query.cursor) params.set("cursor", query.cursor);
  if (query.limit) params.set("limit", String(query.limit));
  if (query.model) params.set("model", query.model);
  if (query.status) params.set("status", query.status);
  if (query.from) params.set("from", query.from);
  if (query.to) params.set("to", query.to);
  const suffix = params.size ? `?${params.toString()}` : "";
  const payload = await requestJson<unknown>(`/logs${suffix}`, { signal });
  return normalizeBeaconLogsPage(payload);
}

export async function getBeaconRequestDetail(
  requestId: string,
  signal?: AbortSignal,
): Promise<BeaconRequestDetail> {
  const payload = await requestJson<unknown>(`/requests/${encodeURIComponent(requestId)}`, { signal });
  return normalizeBeaconRequestDetail(payload);
}
