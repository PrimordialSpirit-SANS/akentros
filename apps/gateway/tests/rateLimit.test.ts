import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import {
  AKENTROS_IP_RATE_LIMIT_SQL,
  createDbWindowStore,
  createRateLimit,
  resetRateLimitsForTests,
} from "../src/middleware/rateLimit.ts";

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
