import assert from "node:assert/strict";
import test from "node:test";
import {
  akentrosMetricsHandler,
  recordAkentrosAiRequest,
  recordAkentrosSettlement,
  renderAkentrosPrometheus,
} from "../src/utils/metrics.ts";

test("metrics render Prometheus text format with labels, sums, and gauges", () => {
  recordAkentrosAiRequest("chat.completions", 200, 1500);
  recordAkentrosAiRequest("embeddings", 200, 250);
  recordAkentrosAiRequest("embeddings", 401, 1);
  recordAkentrosSettlement({ inputTokens: "120", outputTokens: 8, actualCostMicros: 250 });
  recordAkentrosSettlement({ inputTokens: 40, outputTokens: 0, actualCostMicros: 100 });

  const body = renderAkentrosPrometheus({ dbUp: true });
  const lines = body.split("\n");

  assert.ok(lines.includes("# TYPE akentros_ai_requests_total counter"));
  assert.ok(lines.includes('akentros_ai_requests_total{endpoint="chat.completions",status="200"} 1'));
  assert.ok(lines.includes('akentros_ai_requests_total{endpoint="embeddings",status="401"} 1'));
  // 250ms + 1ms 的浮點加總;以正規表達式避免浮點尾數。
  assert.match(body, /akentros_ai_request_duration_seconds_sum\{endpoint="embeddings"\} 0\.251/);
  assert.ok(lines.includes('akentros_ai_request_duration_seconds_count{endpoint="embeddings"} 2'));
  assert.ok(lines.includes('akentros_ai_tokens_total{direction="input"} 160'));
  assert.ok(lines.includes('akentros_ai_tokens_total{direction="output"} 8'));
  assert.ok(lines.includes("akentros_ai_spend_usd_micros_total 350"));
  assert.ok(lines.includes("# TYPE akentros_db_up gauge"));
  assert.ok(lines.includes("akentros_db_up 1"));
  assert.ok(lines.includes("akentros_up 1"));
  // 結尾換行:Prometheus 解析器期望最後一行終止。
  assert.ok(body.endsWith("\n"));
});

test("metrics handler probes the database and serves the exposition format", async () => {
  const handler = akentrosMetricsHandler(async () => true);
  const headers = new Map<string, string>();
  const response = await handler({ header: (name: string, value: string) => headers.set(name, value) });
  assert.equal(response.status, 200);
  assert.equal(headers.get("Cache-Control"), "no-store");
  assert.match(String(response.headers.get("content-type")), /text\/plain/);
  const body = await response.text();
  assert.match(body, /akentros_db_up 1/);

  const degraded = await akentrosMetricsHandler(async () => false)({
    header: () => {},
  });
  assert.match(await degraded.text(), /akentros_db_up 0/);
});
