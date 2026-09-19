import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { createApp } from "../src/app.ts";
import { BEACON_CSRF_COOKIE, beaconAuthRateLimitIdentity, requireCsrfToken } from "../src/routes/auth.ts";
import { installBeaconDbAdapter } from "../src/utils/db.ts";

// 只覆蓋不需要資料庫的行為:fail-closed 開關、CSRF 雙提交、輸入驗證,
// 以及錯誤路徑在 DB 之前的分支。需要 DB 的端點由整合測試覆蓋。

const SECRET = "x".repeat(32);

// createApp 只把 env 烘進 fail-closed 閘門;路由內部讀的是 c.env(Worker
// 執行期注入)。測試以一層 middleware 模擬這個注入。
function createTestApp(env: any = {}) {
  const outer = new Hono();
  outer.use("*", async (c: any, next: any) => {
    c.env = env;
    await next();
  });
  outer.route("/", createApp(env));
  return outer;
}

function aiRequest(path: string, env: any = {}, init: any = {}) {
  return createTestApp(env).request(path, init);
}

test("beacon routes return 404 when BEACON_ENABLED is not true", async () => {
  for (const env of [undefined, {}, { BEACON_ENABLED: "1" }, { BEACON_ENABLED: "false" }]) {
    const response = await aiRequest("/api/ai/v1/models", env);
    assert.equal(response.status, 404);
    const body = (await response.json()) as any;
    assert.equal(body.code, "route_not_found");
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});

test("public inference face returns 401 without a bearer key", async () => {
  const response = await aiRequest("/api/ai/v1/models", { BEACON_ENABLED: "true" });
  assert.equal(response.status, 401);
  const body = (await response.json()) as any;
  assert.equal(body.error.type, "authentication_error");
  assert.equal(body.error.code, "invalid_api_key");
});

test("developer face is protected by session cookie, not bearer keys", async () => {
  const response = await aiRequest("/api/ai/developer/keys", {
    BEACON_ENABLED: "true",
    JWT_SECRET: SECRET,
  });
  // 無 cookie 時 authenticateToken 回 401;CSRF 只管 mutating 請求。
  assert.equal(response.status, 401);
  const body = (await response.json()) as any;
  assert.equal(body.code, "authentication_required");
});

test("mutating developer requests without CSRF cookie still require a session first", async () => {
  // 沒有 csrf_token cookie 時 requireCsrfToken 放行(尚未取得 session),
  // 隨後由 authenticateToken 擋下 401,確保兩層防護都在。
  const response = await aiRequest(
    "/api/ai/developer/keys",
    {
      BEACON_ENABLED: "true",
      JWT_SECRET: SECRET,
    },
    { method: "POST" },
  );
  assert.equal(response.status, 401);
});

test("CSRF double-submit rejects mismatched header when cookie is present", async () => {
  const app = new Hono();
  app.use("/api/*", requireCsrfToken);
  app.post("/api/ok", (c: any) => c.json({ ok: true }));

  const mismatched = await app.request("/api/ok", {
    method: "POST",
    headers: {
      Cookie: `${BEACON_CSRF_COOKIE}=cookie-token`,
      "X-CSRF-Token": "other-token",
    },
  });
  assert.equal(mismatched.status, 403);
  const body = (await mismatched.json()) as any;
  assert.equal(body.code, "csrf_token_invalid");

  const missing = await app.request("/api/ok", {
    method: "POST",
    headers: { Cookie: `${BEACON_CSRF_COOKIE}=cookie-token` },
  });
  assert.equal(missing.status, 403);
});

test("CSRF double-submit accepts matching header and passes GET through", async () => {
  const app = new Hono();
  app.use("/api/*", requireCsrfToken);
  app.post("/api/ok", (c: any) => c.json({ ok: true }));
  app.get("/api/ok", (c: any) => c.json({ ok: true }));

  const matched = await app.request("/api/ok", {
    method: "POST",
    headers: {
      Cookie: `${BEACON_CSRF_COOKIE}=cookie-token`,
      "X-CSRF-Token": "cookie-token",
    },
  });
  assert.equal(matched.status, 200);

  const read = await app.request("/api/ok");
  assert.equal(read.status, 200);
});

test("session endpoints validate input before touching the database", async () => {
  const base = { BEACON_ENABLED: "true", JWT_SECRET: SECRET };

  const badJson = await aiRequest("/api/auth/login", base, {
    method: "POST",
    body: "not-json",
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(badJson.status, 400);

  const cases = [
    [{ email: "nope", username: "ab", password: "longenough1" }, "invalid_email"],
    [{ email: "a@b.co", username: "a", password: "longenough1" }, "invalid_username"],
    [{ email: "a@b.co", username: "ab", password: "short" }, "invalid_password"],
  ];
  for (const [payload, code] of cases) {
    const response = await aiRequest("/api/auth/register", base, {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as any).code, code);
  }
});

test("registration can be disabled per deployment", async () => {
  const response = await aiRequest(
    "/api/auth/register",
    {
      BEACON_ENABLED: "true",
      JWT_SECRET: SECRET,
      BEACON_DISABLE_REGISTRATION: "true",
    },
    {
      method: "POST",
      body: JSON.stringify({ email: "a@b.co", username: "ab", password: "longenough1" }),
      headers: { "Content-Type": "application/json" },
    },
  );
  assert.equal(response.status, 403);
  assert.equal(((await response.json()) as any).code, "registration_disabled");
});

test("session token verification fails closed on weak configuration", async () => {
  const response = await aiRequest("/api/auth/me", { JWT_SECRET: "too-short" });
  assert.equal(response.status, 503);
  assert.equal(((await response.json()) as any).code, "auth_configuration_unavailable");

  const anonymous = await aiRequest("/api/auth/me", { JWT_SECRET: SECRET });
  assert.equal(anonymous.status, 401);
});

test("auth rate limit identity uses the socket address unless a proxy is explicitly trusted", async () => {
  const app = new Hono();
  app.get("/identity", (c: any) => c.json({ identity: beaconAuthRateLimitIdentity(c) }));
  const identity = async (env: any, headers: Record<string, string> = {}) => {
    const response = await app.request("/identity", { headers }, env);
    return ((await response.json()) as any).identity as string;
  };
  const forged = { "cf-connecting-ip": "6.6.6.6" };

  // Node 自架(未宣告信任代理):偽造 cf-connecting-ip 無效,以不可偽造的
  // socket 來源位址為限流身份 —— 攻擊者無法逐請求換 IP 繞過限流。
  assert.equal(await identity({ BEACON_REMOTE_ADDR: "10.0.0.1" }, forged), "10.0.0.1");
  // Workers/DO 部署(runtime 內無 socket 位址):標頭由 Cloudflare 覆寫附加。
  assert.equal(await identity({}, forged), "6.6.6.6");
  // 明確信任反向代理時:以標頭為準;沒有標頭的信任部署併入 local。
  assert.equal(
    await identity({ BEACON_TRUST_PROXY: "true", BEACON_REMOTE_ADDR: "10.0.0.1" }, forged),
    "6.6.6.6",
  );
  assert.equal(await identity({ BEACON_TRUST_PROXY: "true" }, {}), "local");
  // 都拿不到:local 共享桶。
  assert.equal(await identity({}, {}), "local");
});

test("/healthz is available without the fail-closed gate and reports database state", async () => {
  // adapter 未安裝(DB 探測失敗):仍可達,但回 503 degraded。
  const degraded = await aiRequest("/healthz", { BEACON_ENABLED: "false" });
  assert.equal(degraded.status, 503);
  const degradedBody = (await degraded.json()) as any;
  assert.equal(degradedBody.status, "degraded");
  assert.equal(degradedBody.database, "unavailable");
  assert.equal(degraded.headers.get("cache-control"), "no-store");

  // 安裝可用 adapter 後回 200 ok。放在本測試檔最後,避免污染其他案例。
  installBeaconDbAdapter({
    dbQuery: async () => ({ rows: [{ ok: 1 }] }),
    dbGet: async () => null,
    withBeaconTransaction: async (_env: any, fn: () => Promise<any>) => fn(),
    createBeaconQuery: () => async () => ({ rows: [] }),
    closePostgresClients: async () => {},
  });
  const ok = await aiRequest("/healthz", {});
  assert.equal(ok.status, 200);
  const okBody = (await ok.json()) as any;
  assert.equal(okBody.status, "ok");
  assert.equal(okBody.database, "ok");
});
