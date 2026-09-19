// 平台整合接縫:console 邏輯層(lib/akentros)所有 API 呼叫的底層。
// 原始平台在此提供 JWT 會話、CSRF 與外部 API base;本獨立版以同源 cookie session
// 加上環境變數設定重現相同契約。離線示範模式由 demoApi.ts 以 fetch 攔截實現。

const API_BASE = (import.meta.env.VITE_AKENTROS_API_BASE ?? "/api").replace(/\/+$/, "");

function readCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const method = (init.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    const csrf = readCookie("csrf_token") ?? readCookie("XSRF-TOKEN");
    if (csrf && !headers.has("X-CSRF-Token")) {
      headers.set("X-CSRF-Token", csrf);
    }
  }
  return fetch(`${API_BASE}${path}`, { ...init, headers, credentials: "include" });
}

export function getExternalDeveloperApiBase(): string {
  const configured = import.meta.env.VITE_AKENTROS_PUBLIC_API_BASE;
  if (configured) return configured.replace(/\/+$/, "");
  return window.location.origin;
}
