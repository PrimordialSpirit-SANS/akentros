// 平台整合接縫:console 邏輯層(lib/akentros)所有 API 呼叫的底層。
// 原始平台在此提供 JWT 會話、CSRF 與外部 API base;本獨立版以同源 cookie session
// 加上環境變數設定重現相同契約。離線示範模式由 demoApi.ts 以 fetch 攔截實現。

// FN-10 fix:`??` 換成 `||` —— 環境變數設為空字串時(對照 .env.example
// 「留空時使用同源的 /api」),`??` 不會放行 fallback,所有請求打到錯誤的
// /auth/* 路徑;`||` 讓空字串正確退回同源 /api。
const API_BASE = (import.meta.env.VITE_AKENTROS_API_BASE || "/api").replace(/\/+$/, "");

// SN-16 fix (audit N5):原本 name 直接插值進入 RegExp 建構式,若 name 含
// RegExp 中繼字元(如 .、*、+、?、(、)、[、]、{、}、^、$、|、\\)會匹配
// 到非預期的 cookie 或丟出例外。目前所有呼叫端都用硬編碼字串
// (csrf_token、XSRF-TOKEN)無中繼字元,實際安全;但這是防禦縱深缺口——
// 逸出後即使未來傳入使用者或 URL 控制的名稱也不會破壞 regex。
function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readCookie(name: string): string | null {
  const pattern = new RegExp(`(?:^|;\\s*)${escapeRegexLiteral(name)}=([^;]*)`);
  const match = document.cookie.match(pattern);
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
