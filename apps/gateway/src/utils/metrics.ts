// 程序內 Prometheus 計數器與 /metrics 輸出。Node 自架拓撲由 nodeServer 掛載
// /metrics;Workers 拓撲不掛載(隔離區生命週期使程序內計數失去意義,觀測走
// Cloudflare observability)。零依賴:僅以 Map 累加,輸出為純字串組裝,
// 不使用任何 Node 專屬 API,因此在兩種拓撲都能安全 import。

const METRIC_FAMILIES: Array<{ name: string; help: string; type: "counter" | "gauge" }> = [
  {
    name: "akentros_ai_requests_total",
    help: "Akentros public AI requests by endpoint and HTTP status code.",
    type: "counter",
  },
  {
    name: "akentros_ai_request_duration_seconds",
    help: "Akentros public AI request duration in seconds (sum and count per endpoint).",
    type: "counter",
  },
  {
    name: "akentros_ai_tokens_total",
    help: "Akentros settled token usage by direction (input or output).",
    type: "counter",
  },
  {
    name: "akentros_ai_spend_usd_micros_total",
    help: "Akentros settled spend in micro-USD (1 USD = 1000000 micros).",
    type: "counter",
  },
  {
    name: "akentros_up",
    help: "Whether the Akentros process reports itself as up.",
    type: "gauge",
  },
  {
    name: "akentros_process_uptime_seconds",
    help: "Seconds since the Akentros process started serving requests.",
    type: "gauge",
  },
  {
    name: "akentros_db_up",
    help: "Whether the database answered the latest scrape probe.",
    type: "gauge",
  },
];

const series = new Map<string, number>();
const startedAtMs = performance.now();

function escapeLabelValue(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
}

function seriesName(name: string, labels: Record<string, string | number>) {
  const entries = Object.entries(labels);
  if (entries.length === 0) return name;
  entries.sort(([left], [right]) => left.localeCompare(right));
  const rendered = entries.map(([key, value]) => `${key}="${escapeLabelValue(String(value))}"`).join(",");
  return `${name}{${rendered}}`;
}

function record(name: string, labels: Record<string, string | number>, delta: number) {
  const key = seriesName(name, labels);
  series.set(key, (series.get(key) || 0) + delta);
}

export function recordAkentrosAiRequest(endpoint: string, status: number, durationMs: number) {
  const statusLabel = status > 0 ? String(status) : "unknown";
  record("akentros_ai_requests_total", { endpoint, status: statusLabel }, 1);
  const durationSeconds = Math.max(0, durationMs) / 1000;
  record("akentros_ai_request_duration_seconds_sum", { endpoint }, durationSeconds);
  record("akentros_ai_request_duration_seconds_count", { endpoint }, 1);
}

// AkentrosBillingSettleInput 的數值欄位接受 number/string/bigint
// (AkentrosMicrosInput);指標統一正規化為安全整數,不合法值記為 0。
function toSafeCount(value: unknown): number {
  if (typeof value === "bigint") {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : 0;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : 0;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  return 0;
}

export function recordAkentrosSettlement(input: {
  inputTokens?: unknown;
  outputTokens?: unknown;
  actualCostMicros?: unknown;
}) {
  const inputTokens = toSafeCount(input.inputTokens);
  if (inputTokens > 0) {
    record("akentros_ai_tokens_total", { direction: "input" }, inputTokens);
  }
  const outputTokens = toSafeCount(input.outputTokens);
  if (outputTokens > 0) {
    record("akentros_ai_tokens_total", { direction: "output" }, outputTokens);
  }
  const costMicros = toSafeCount(input.actualCostMicros);
  if (costMicros > 0) {
    record("akentros_ai_spend_usd_micros_total", {}, costMicros);
  }
}

function renderSeries(ready: string[], baseName: string, prefixes: string[]) {
  const matching = [...series.entries()].filter(([key]) =>
    prefixes.some((prefix) => key === prefix || key.startsWith(`${prefix}{`)),
  );
  if (matching.length === 0) return;
  const family = METRIC_FAMILIES.find((candidate) => candidate.name === baseName);
  if (family) {
    ready.push(`# HELP ${family.name} ${family.help}`);
    ready.push(`# TYPE ${family.name} ${family.type}`);
  }
  for (const [key, value] of matching) ready.push(`${key} ${value}`);
}

export function renderAkentrosPrometheus({ dbUp }: { dbUp: boolean }) {
  const ready: string[] = [];
  for (const family of METRIC_FAMILIES) {
    if (family.name === "akentros_ai_request_duration_seconds") {
      renderSeries(ready, family.name, [
        "akentros_ai_request_duration_seconds_sum",
        "akentros_ai_request_duration_seconds_count",
      ]);
      continue;
    }
    renderSeries(ready, family.name, [family.name]);
  }
  ready.push(`# HELP akentros_up Whether the Akentros process reports itself as up.`);
  ready.push(`# TYPE akentros_up gauge`);
  ready.push(`akentros_up 1`);
  ready.push(
    `# HELP akentros_process_uptime_seconds Seconds since the Akentros process started serving requests.`,
  );
  ready.push(`# TYPE akentros_process_uptime_seconds gauge`);
  ready.push(`akentros_process_uptime_seconds ${((performance.now() - startedAtMs) / 1000).toFixed(3)}`);
  ready.push(`# HELP akentros_db_up Whether the database answered the latest scrape probe.`);
  ready.push(`# TYPE akentros_db_up gauge`);
  ready.push(`akentros_db_up ${dbUp ? 1 : 0}`);
  ready.push("");
  return ready.join("\n");
}

// /metrics 探針:與 /healthz 相同立場——不屬於 AKENTROS_ENABLED fail-closed
// 閘門,但只在 Node 進入點掛載,Workers 部署不暴露。回傳 Hono 相容 handler。
export function akentrosMetricsHandler(probeDatabase: () => Promise<boolean>) {
  return async (c: { header: (name: string, value: string) => void }) => {
    const dbUp = await probeDatabase().catch(() => false);
    c.header("Cache-Control", "no-store");
    return new Response(renderAkentrosPrometheus({ dbUp }), {
      status: 200,
      headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
    });
  };
}
