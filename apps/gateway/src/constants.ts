// 本機開發的預設允許來源。正式環境請以 FRONTEND_ORIGINS 環境變數補充。
export const DEFAULT_ALLOWED_ORIGINS: readonly string[] = Object.freeze([
  "http://localhost:5173",
  "http://localhost:4173",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:4173",
]);
