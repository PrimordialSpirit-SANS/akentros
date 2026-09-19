export function formatUsd(value: string | number): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "$0.00";
  if (amount >= 1000) {
    return `$${new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 0 }).format(amount)}`;
  }
  if (amount >= 0.01) return `$${amount.toFixed(2)}`;
  return `$${amount.toFixed(4)}`;
}

export function formatPoints(value: number): string {
  return new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 0 }).format(value);
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) {
    return `${new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 1 }).format(value / 1_000_000)}M`;
  }
  if (value >= 1_000) {
    return `${new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 1 }).format(value / 1_000)}K`;
  }
  return new Intl.NumberFormat("zh-TW").format(value);
}

export function formatAkentrosTimestamp(value: string | null | undefined): string {
  if (!value) return "尚未使用";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function formatLatency(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (value >= 1000) return `${(value / 1000).toFixed(2)} s`;
  return `${Math.round(value)} ms`;
}

export function formatModelLimit(value: number): string {
  return value >= 1000 ? `${Math.round(value / 1000)}K` : String(value);
}
