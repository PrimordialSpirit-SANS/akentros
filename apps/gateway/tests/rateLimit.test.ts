import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import {
  AKENTROS_IP_RATE_LIMIT_SQL,
  createDbWindowStore,
  createRateLimit,
  resetRateLimitsForTests,
} from "../src/middleware/rateLimit.ts";
import { akentrosAuthRateLimitIdentity } from "../src/routes/auth.ts";

function appWithLimiter(options: any) {
  const app = new Hono();
  app.use("*", createRateLimit(options));
  app.get("/", (c: any) => c.json({ ok: true }));
  return app;
}

test("in-isolate fallback allows up to max and then 429s with Retry-After", async () => {
  resetRateLimitsForTests();
  const app = appWithLimiter({
    keyPrefix: "test",
    windowMs: 60_000,
    max: 3,
    keyGenerator: (c: any) => String(c.req.header("cf-connecting-ip") || "local"),
  });

  for (let index = 0; index < 3; index += 1) {
    const response = await app.request("/", { headers: { "cf-connecting-ip": "1.2.3.4" } });
    assert.equal(response.status, 200);
  }
  const blocked = await app.request("/", { headers: { "cf-connecting-ip": "1.2.3.4" } });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get("retry-after")) >= 1);

  // 不同身份不受影響。
  const other = await app.request("/", { headers: { "cf-connecting-ip": "5.6.7.8" } });
  assert.equal(other.status, 200);
});

test("memory overflow evicts expired buckets but never resets live counters", async () => {
  resetRateLimitsForTests();
  const app = appWithLimiter({
    keyPrefix: "flood",
    windowMs: 60_000,
    max: 2,
    keyGenerator: (c: any) => String(c.req.header("cf-connecting-ip") || "local"),
  });

  const existingIdentity = "10.0.0.1";
  for (let index = 0; index < 2; index += 1) {
    const response = await app.request("/", { headers: { "cf-connecting-ip": existingIdentity } });
    assert.equal(response.status, 200);
  }

  // 用新身份填滿追蹤上限(全部未過期,不可淘汰);既有身份佔 1 格,
  // 所以剛好 9_999 個新身份可被追蹤,不觸發溢出。
  let flooded = false;
  for (let index = 0; index < 9_999; index += 1) {
    const response = await app.request("/", {
      headers: { "cf-connecting-ip": `10.1.${index >> 8}.${index & 255}` },
    });
    if (response.status === 429) flooded = true;
    else assert.equal(response.status, 200);
  }
  assert.equal(flooded, false);

  // 溢出後的新身份直接 429,且既有身份的計數不被整表清除。
  const overflowNewcomer = await app.request("/", { headers: { "cf-connecting-ip": "10.2.0.1" } });
  assert.equal(overflowNewcomer.status, 429);

  resetRateLimitsForTests();
  const app2 = appWithLimiter({ keyPrefix: "flood", windowMs: 60_000, max: 2 });
  for (let index = 0; index < 2; index += 1) {
    await app2.request("/", { headers: { "cf-connecting-ip": existingIdentity } });
  }
  const existing = await app2.request("/", { headers: { "cf-connecting-ip": existingIdentity } });
  assert.equal(existing.status, 429);
});

test("db window store counts within a window and resets when the window rolls", async () => {
  let windowStart = "2026-01-01T00:00:00.000Z";
  let count = 0;
  const queries: string[] = [];
  const store = createDbWindowStore(async (sql: string, params: any[]) => {
    queries.push(sql);
    if (sql === AKENTROS_IP_RATE_LIMIT_SQL.increment) {
      assert.equal(params[0], "akentros-auth:1.2.3.4");
      if (params[1] !== windowStart) {
        windowStart = params[1];
        count = 0;
      }
      count += 1;
      return { rows: [{ hit_count: count }] };
    }
    return { rows: [] };
  });

  const start = windowStart;
  assert.equal(await store.increment("akentros-auth:1.2.3.4", start, start), 1);
  assert.equal(await store.increment("akentros-auth:1.2.3.4", start, start), 2);
  assert.equal(await store.increment("akentros-auth:1.2.3.4", start, start), 3);

  // 窗口滾動:同一 identity 歸零重計,並觸發 sweep。
  const rolled = "2026-01-01T00:15:00.000Z";
  assert.equal(await store.increment("akentros-auth:1.2.3.4", rolled, start), 1);
  assert.ok(queries.includes(AKENTROS_IP_RATE_LIMIT_SQL.sweep));
});

test("sweep failure does not break counting", async () => {
  let count = 0;
  const store = createDbWindowStore(async (sql: string) => {
    if (sql === AKENTROS_IP_RATE_LIMIT_SQL.sweep) throw new Error("sweep unavailable");
    count += 1;
    return { rows: [{ hit_count: count }] };
  });
  assert.equal(await store.increment("k", "2026-01-01T00:00:00.000Z", "2025-12-31T00:00:00.000Z"), 1);
});

test("middleware degrades to memory limiter when the database is unavailable", async () => {
  resetRateLimitsForTests();
  const app = new Hono();
  app.use("*", createRateLimit({ keyPrefix: "degrade", windowMs: 60_000, max: 1 }));
  app.get("/", (c: any) => c.json({ ok: true }));

  // DATABASE_URL 指向不可連線的位址 → dbQuery 拋錯 → 降級記憶體路徑。
  const injectApp = new Hono();
  injectApp.use("*", async (c: any, next: any) => {
    c.env = { DATABASE_URL: "postgresql://127.0.0.1:1/none" };
    await next();
  });
  injectApp.use("*", createRateLimit({ keyPrefix: "degrade", windowMs: 60_000, max: 1 }));
  injectApp.get("/", (c: any) => c.json({ ok: true }));

  const first = await injectApp.request("/");
  assert.equal(first.status, 200);
  const second = await injectApp.request("/");
  assert.equal(second.status, 429);
});

// SEC-02 fix:無 socket 位址、未開 AKENTROS_TRUST_PROXY、卻帶 cf-connecting-ip
// 是「自行嵌入 createApp()」的部署(測試殼、邊車)才會走到的退化分支 ——
// 正式進入點(nodeServer 注入 AKENTROS_REMOTE_ADDR、Workers 由 Cloudflare
// 覆寫標頭)不會踩到。行為保留(以標頭值為身份計數),但必須對運維發出
// 一次性 akentros_auth_rate_limit_identity_untrusted_header 告警,拓撲
// 不得再隱形。
test("untrusted cf-connecting-ip fallback counts per header value and warns exactly once (SEC-02)", async () => {
  resetRateLimitsForTests();
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (line: unknown) => {
    warnings.push(String(line));
  };
  try {
    const app = new Hono();
    // 模擬未經 nodeServer.ts/worker.ts 整合的嵌入部署:env 存在但沒有
    // AKENTROS_REMOTE_ADDR,也未宣告 AKENTROS_TRUST_PROXY。
    app.use("*", async (c: any, next: any) => {
      c.env = {};
      await next();
    });
    app.use(
      "*",
      createRateLimit({
        keyPrefix: "sec02",
        windowMs: 60_000,
        max: 2,
        keyGenerator: akentrosAuthRateLimitIdentity,
      }),
    );
    app.get("/", (c: any) => c.json({ ok: true }));

    // 以標頭值為身份計數:同一假 IP 額滿後 429,換一個假 IP 即是新身份。
    const first = await app.request("/", { headers: { "cf-connecting-ip": "10.9.8.7" } });
    assert.equal(first.status, 200);
    const second = await app.request("/", { headers: { "cf-connecting-ip": "10.9.8.7" } });
    assert.equal(second.status, 200);
    const blocked = await app.request("/", { headers: { "cf-connecting-ip": "10.9.8.7" } });
    assert.equal(blocked.status, 429, "the spoofable header value is the counting identity");
    const other = await app.request("/", { headers: { "cf-connecting-ip": "10.9.8.6" } });
    assert.equal(other.status, 200, "a different header value is a different identity");

    // 直接驗證身份函式回傳標頭值(而非 "local" 共享桶)。
    const identity = akentrosAuthRateLimitIdentity({
      req: { header: (name: string) => (name === "cf-connecting-ip" ? "203.0.113.9" : "") },
      env: {},
    } as any);
    assert.equal(identity, "203.0.113.9");

    // 一次性告警:多次請求只發出一次,且攔截不到其它退化成因的告警重複。
    const untrusted = warnings.filter((line) =>
      line.includes("akentros_auth_rate_limit_identity_untrusted_header"),
    );
    assert.equal(untrusted.length, 1, "exactly one one-time untrusted-header warning");
    assert.match(untrusted[0] || "", /spoofable cf-connecting-ip/);
    assert.match(untrusted[0] || "", /AKENTROS_TRUST_PROXY/);
  } finally {
    console.warn = originalWarn;
  }
});
