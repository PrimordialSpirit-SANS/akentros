import assert from "node:assert/strict";
import test from "node:test";
import {
  akentrosMetricsHandler,
  evaluateMetricsAccess,
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
  const response = await handler({
    header: (name: string, value: string) => headers.set(name, value),
    env: { AKENTROS_REMOTE_ADDR: "127.0.0.1" },
  });
  assert.equal(response.status, 200);
  assert.equal(headers.get("Cache-Control"), "no-store");
  assert.match(String(response.headers.get("content-type")), /text\/plain/);
  const body = await response.text();
  assert.match(body, /akentros_db_up 1/);

  const degraded = await akentrosMetricsHandler(async () => false)({
    header: () => {},
    env: { AKENTROS_REMOTE_ADDR: "127.0.0.1" },
  });
  assert.match(await degraded.text(), /akentros_db_up 0/);
});

test("metrics access control requires a token or a loopback source (SN-1)", async () => {
  const base = { now: 1_000_000 };
  // 未設 token:僅 loopback 放行,外部來源 404(不暴露端點存在)。
  assert.equal(evaluateMetricsAccess({ ...base, remoteAddr: "127.0.0.1" }), "allow");
  assert.equal(evaluateMetricsAccess({ ...base, remoteAddr: "::1" }), "allow");
  assert.equal(evaluateMetricsAccess({ ...base, remoteAddr: "203.0.113.7" }), "forbidden");
  assert.equal(evaluateMetricsAccess({ ...base }), "forbidden");
  // 設了 token:Bearer 比對正確才放行;外部來源 + 有效 token 也放行。
  const token = { token: "metrics-secret-32-chars-long-token!", ...base };
  assert.equal(
    evaluateMetricsAccess({
      ...token,
      remoteAddr: "203.0.113.7",
      authorization: "Bearer metrics-secret-32-chars-long-token!",
    }),
    "allow",
  );
  assert.equal(
    evaluateMetricsAccess({ ...token, remoteAddr: "203.0.113.7", authorization: "Bearer wrong-token" }),
    "unauthorized",
  );
  assert.equal(evaluateMetricsAccess({ ...token, remoteAddr: "203.0.113.7" }), "unauthorized");
  assert.equal(
    evaluateMetricsAccess({
      ...token,
      remoteAddr: "127.0.0.1",
      authorization: "Bearer wrong-token",
    }),
    "unauthorized",
  );
  // 每來源 60 秒視窗最多 12 次 scrape,超過 429。
  let windowStart = 5_000_000;
  let verdict: string = "allow";
  for (let i = 0; i < 13; i += 1) {
    verdict = evaluateMetricsAccess({
      token: "t",
      remoteAddr: "198.51.100.9",
      authorization: "Bearer t",
      now: windowStart,
    });
  }
  assert.equal(verdict, "rate_limited");
  // 下一個視窗恢復。
  windowStart += 61_000;
  assert.equal(
    evaluateMetricsAccess({
      token: "t",
      remoteAddr: "198.51.100.9",
      authorization: "Bearer t",
      now: windowStart,
    }),
    "allow",
  );
  // handler 層的 401/404/429 回應形狀。
  const handler = akentrosMetricsHandler(async () => true);
  const unauthorized = await handler({
    header: () => {},
    env: { AKENTROS_METRICS_TOKEN: "metrics-secret-32-chars-long-token!" },
    req: { header: () => undefined },
  });
  assert.equal(unauthorized.status, 401);
  const forbidden = await handler({
    header: () => {},
    env: { AKENTROS_REMOTE_ADDR: "203.0.113.7" },
    req: { header: () => undefined },
  });
  assert.equal(forbidden.status, 404);
});
