// 結構化日誌:一律輸出單行 JSON,供 log 採集器(Cloudflare observability、
// journald、Loki…)直接解析,不再需要自訂剖析規則。
// 欄位僅限事件中繼資料(code、path、error name 等);prompt、completion、
// 完整金鑰與供應商 token 仍不得出現在日誌(見 README 安全模型)。

export type BeaconLogLevel = "info" | "warn" | "error";

export function logBeaconEvent(
  level: BeaconLogLevel,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  const line = JSON.stringify({ time: new Date().toISOString(), level, event, ...fields });
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}
