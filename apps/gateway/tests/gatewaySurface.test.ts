import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { createApp } from "../src/app.ts";
import { AKENTROS_CSRF_COOKIE, akentrosAuthRateLimitIdentity, requireCsrfToken } from "../src/routes/auth.ts";
import { installAkentrosDbAdapter } from "../src/utils/db.ts";

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

test("akentros routes return 404 when AKENTROS_ENABLED is not true", async () => {
  for (const env of [undefined, {}, { AKENTROS_ENABLED: "1" }, { AKENTROS_ENABLED: "false" }]) {
    const response = await aiRequest("/api/ai/v1/models", env);
    assert.equal(response.status, 404);
    const body = (await response.json()) as any;
    assert.equal(body.code, "route_not_found");
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});

test("public inference face returns 401 without a bearer key", async () => {
  const response = await aiRequest("/api/ai/v1/models", { AKENTROS_ENABLED: "true" });
  assert.equal(response.status, 401);
  const body = (await response.json()) as any;
  assert.equal(body.error.type, "authentication_error");
  assert.equal(body.error.code, "invalid_api_key");
});

test("developer face is protected by session cookie, not bearer keys", async () => {
  const response = await aiRequest("/api/ai/developer/keys", {
    AKENTROS_ENABLED: "true",
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
      AKENTROS_ENABLED: "true",
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
      Cookie: `${AKENTROS_CSRF_COOKIE}=cookie-token`,
      "X-CSRF-Token": "other-token",
    },
  });
  assert.equal(mismatched.status, 403);
  const body = (await mismatched.json()) as any;
  assert.equal(body.code, "csrf_token_invalid");

  const missing = await app.request("/api/ok", {
    method: "POST",
    headers: { Cookie: `${AKENTROS_CSRF_COOKIE}=cookie-token` },
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
      Cookie: `${AKENTROS_CSRF_COOKIE}=cookie-token`,
      "X-CSRF-Token": "cookie-token",
    },
  });
  assert.equal(matched.status, 200);

  const read = await app.request("/api/ok");
  assert.equal(read.status, 200);
});

test("pre-auth mutating endpoints reject cross-site Origin headers (login CSRF)", async () => {
  const base = { AKENTROS_ENABLED: "true", JWT_SECRET: SECRET };
  const evil = { "Content-Type": "application/json", Origin: "https://evil.example" };

  // 瀏覽器對跨來源 POST 一律附帶 Origin;login CSRF(以攻擊者憑證把受害者
  // 的瀏覽器靜默登入攻擊者帳號)在標頭層即被擋下,403 先於任何 body 解析。
  const login = await aiRequest("/api/auth/login", base, {
    method: "POST",
    body: JSON.stringify({ email: "a@b.co", password: "longenough1" }),
    headers: evil,
  });
  assert.equal(login.status, 403);
  assert.equal(((await login.json()) as any).code, "origin_forbidden");

  const register = await aiRequest("/api/auth/register", base, {
    method: "POST",
    body: JSON.stringify({ email: "a@b.co", username: "ab", password: "longenough1" }),
    headers: evil,
  });
  assert.equal(register.status, 403);
  assert.equal(((await register.json()) as any).code, "origin_forbidden");

  const logout = await aiRequest("/api/auth/logout", base, { method: "POST", headers: evil });
  assert.equal(logout.status, 403);

  // 「null」origin(沙箱 iframe)無法與任何部署同源,同樣拒絕。
  const sandboxed = await aiRequest("/api/auth/login", base, {
    method: "POST",
    body: JSON.stringify({ email: "a@b.co", password: "longenough1" }),
    headers: { "Content-Type": "application/json", Origin: "null" },
  });
  assert.equal(sandboxed.status, 403);

  // Origin 檢查僅限 mutating 請求:GET 不受影響(仍由 authenticateToken 擋 401)。
  const me = await aiRequest("/api/auth/me", base, { headers: { Origin: "https://evil.example" } });
  assert.equal(me.status, 401);
});

test("pre-auth mutating endpoints allow same-origin, allowlisted and absent Origin headers", async () => {
  const base = { AKENTROS_ENABLED: "true", JWT_SECRET: SECRET };
  // 以 400 invalid_request 證明請求「通過」origin 閘門並進入 handler 的
  // 內容驗證 —— 被閘門擋下的請求會是 403 origin_forbidden。
  const post = (headers: Record<string, string>) =>
    aiRequest("/api/auth/login", base, {
      method: "POST",
      body: "not-json",
      headers: { "Content-Type": "application/json", ...headers },
    });

  // 同源:app.request 的請求 url 即 http://localhost/…。
  assert.equal((await post({ Origin: "http://localhost" })).status, 400);
  // CORS 白名單內的開發來源(DEFAULT_ALLOWED_ORIGINS)。
  assert.equal((await post({ Origin: "http://localhost:5173" })).status, 400);
  // Referer 退路:取 Referer 的 origin 判定。
  assert.equal((await post({ Referer: "http://localhost:5173/login" })).status, 400);
  // 非瀏覽器客戶端(curl/SDK)不帶 Origin/Referer → 放行。
  assert.equal((await post({})).status, 400);
});

test("same-origin check honors x-forwarded-* only when a proxy is explicitly trusted", async () => {
  const base = { AKENTROS_ENABLED: "true", JWT_SECRET: SECRET };
  // TLS 終止的代理後方,c.req.url 的 scheme 仍是 http:,瀏覽器 Origin 是 https:
  // —— 這正是 requestOwnOrigin 需要信任代理重建自身來源的拓撲。
  const post = (env: any, headers: Record<string, string>) =>
    aiRequest("/api/auth/login", env, {
      method: "POST",
      body: "not-json",
      headers: { "Content-Type": "application/json", ...headers },
    });
  const proxiedOrigin = {
    "x-forwarded-proto": "https",
    "x-forwarded-host": "console.example.com",
    Origin: "https://console.example.com",
  };

  // 未宣告信任代理:x-forwarded-* 可偽造,同源判定仍以 socket URL 為準 → 403。
  assert.equal((await post(base, proxiedOrigin)).status, 403);
  // 偽造「成對」的 x-forwarded-host + 指向自己的惡意 Origin 也一樣 403 ——
  // 攻擊者無法以假標頭把自身來源改造成自己的 origin。
  assert.equal(
    (
      await post(base, {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "evil.example",
        Origin: "https://evil.example",
      })
    ).status,
    403,
  );

  // 宣告信任代理(承諾前方代理會覆寫 x-forwarded-*):以標頭重建自身來源,
  // 同源請求放行,通過閘門後由內容驗證回 400。
  assert.equal((await post({ ...base, AKENTROS_TRUST_PROXY: "true" }, proxiedOrigin)).status, 400);
  // SN-6 fix:代理鏈的逗號清單取最後一值(append 模式代理把觀察值附加在
  // 尾端,首值是客戶端可注入側)。攻擊者注入的首值不得誤導同源重建。
  assert.equal(
    (
      await post(
        { ...base, AKENTROS_TRUST_PROXY: "true" },
        {
          "x-forwarded-proto": "http, https",
          "x-forwarded-host": "client-injected.example, console.example.com",
          Origin: "https://console.example.com",
        },
      )
    ).status,
    400,
  );
  // 反向:攻擊者把偽值放在可注入側,受信代理的觀察值在尾端主導重建;
  // 若尾端觀察與 Origin 不同源 → 403。
  assert.equal(
    (
      await post(
        { ...base, AKENTROS_TRUST_PROXY: "true" },
        {
          "x-forwarded-proto": "https",
          "x-forwarded-host": "console.example.com, other.internal",
          Origin: "https://console.example.com",
        },
      )
    ).status,
    403,
  );
  // 標頭不成形(壞 host)時退回 socket URL → 非同源 → 403,不會誤放行。
  assert.equal(
    (
      await post(
        { ...base, AKENTROS_TRUST_PROXY: "true" },
        { "x-forwarded-proto": "https", "x-forwarded-host": "not a host", Origin: "https://x" },
      )
    ).status,
    403,
  );
});

test("session endpoints validate input before touching the database", async () => {
  const base = { AKENTROS_ENABLED: "true", JWT_SECRET: SECRET };

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
    // 字元禁則:內部換行、零寬空格、雙向覆寫控制符皆拒於觸庫之前。
    [{ email: "a@b.co", username: "ab\ncd", password: "longenough1" }, "invalid_username"],
    [{ email: "a@b.co", username: "invi\u200Bsible", password: "longenough1" }, "invalid_username"],
    [{ email: "a@b.co", username: "ho\u202Enest", password: "longenough1" }, "invalid_username"],
    // 審查補漏:軟連字號、阿拉伯文記號(ALM)、word joiner。
    [{ email: "a@b.co", username: "so\u00ADoft", password: "longenough1" }, "invalid_username"],
    [{ email: "a@b.co", username: "ar\u061Cab", password: "longenough1" }, "invalid_username"],
    [{ email: "a@b.co", username: "wj\u2060oin", password: "longenough1" }, "invalid_username"],
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
      AKENTROS_ENABLED: "true",
      JWT_SECRET: SECRET,
      AKENTROS_DISABLE_REGISTRATION: "true",
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
  // SN-7 fix 後 auth 端點也在 AKENTROS_ENABLED 閘門管轄內,測試需明確啟用。
  const response = await aiRequest("/api/auth/me", { AKENTROS_ENABLED: "true", JWT_SECRET: "too-short" });
  assert.equal(response.status, 503);
  assert.equal(((await response.json()) as any).code, "auth_configuration_unavailable");

  const anonymous = await aiRequest("/api/auth/me", { AKENTROS_ENABLED: "true", JWT_SECRET: SECRET });
  assert.equal(anonymous.status, 401);
});

test("auth endpoints stay behind the AKENTROS_ENABLED fail-closed gate (SN-7)", async () => {
  // 服務轉暗時,註冊(含每帳號贈點)不再開放:與 /api/ai/* 一律回 404。
  const register = await aiRequest(
    "/api/auth/register",
    { JWT_SECRET: SECRET },
    {
      method: "POST",
      body: JSON.stringify({ email: "gated@example.com", password: "LongPassword123!" }),
      headers: { "Content-Type": "application/json" },
    },
  );
  assert.equal(register.status, 404);
  const login = await aiRequest(
    "/api/auth/login",
    { JWT_SECRET: SECRET },
    {
      method: "POST",
      body: JSON.stringify({ email: "gated@example.com", password: "LongPassword123!" }),
      headers: { "Content-Type": "application/json" },
    },
  );
  assert.equal(login.status, 404);
});

test("auth rate limit identity uses the socket address unless a proxy is explicitly trusted", async () => {
  const app = new Hono();
  app.get("/identity", (c: any) => c.json({ identity: akentrosAuthRateLimitIdentity(c) }));
  const identity = async (env: any, headers: Record<string, string> = {}) => {
    const response = await app.request("/identity", { headers }, env);
    return ((await response.json()) as any).identity as string;
  };
  const forged = { "cf-connecting-ip": "6.6.6.6" };

  // Node 自架(未宣告信任代理):偽造 cf-connecting-ip 無效,以不可偽造的
  // socket 來源位址為限流身份 —— 攻擊者無法逐請求換 IP 繞過限流。
  assert.equal(await identity({ AKENTROS_REMOTE_ADDR: "10.0.0.1" }, forged), "10.0.0.1");
  // Workers/DO 部署(runtime 內無 socket 位址):標頭由 Cloudflare 覆寫附加。
  assert.equal(await identity({}, forged), "6.6.6.6");
  // 明確信任反向代理時:以標頭為準;沒有標頭的信任部署併入 local。
  assert.equal(
    await identity({ AKENTROS_TRUST_PROXY: "true", AKENTROS_REMOTE_ADDR: "10.0.0.1" }, forged),
    "6.6.6.6",
  );
  assert.equal(await identity({ AKENTROS_TRUST_PROXY: "true" }, {}), "local");
  // 都拿不到:local 共享桶。
  assert.equal(await identity({}, {}), "local");
});

test("/healthz is available without the fail-closed gate and reports database state", async () => {
  // adapter 未安裝(DB 探測失敗):仍可達,但回 503 degraded。
  const degraded = await aiRequest("/healthz", { AKENTROS_ENABLED: "false" });
  assert.equal(degraded.status, 503);
  const degradedBody = (await degraded.json()) as any;
  assert.equal(degradedBody.status, "degraded");
  assert.equal(degradedBody.database, "unavailable");
  assert.equal(degraded.headers.get("cache-control"), "no-store");

  // 安裝可用 adapter 後回 200 ok。放在本測試檔最後,避免污染其他案例。
  installAkentrosDbAdapter({
    dbQuery: async () => ({ rows: [{ ok: 1 }] }),
    dbGet: async () => null,
    withAkentrosTransaction: async (_env: any, fn: () => Promise<any>) => fn(),
    createAkentrosQuery: () => async () => ({ rows: [] }),
    closePostgresClients: async () => {},
  });
  const ok = await aiRequest("/healthz", {});
  assert.equal(ok.status, 200);
  const okBody = (await ok.json()) as any;
  assert.equal(okBody.status, "ok");
  assert.equal(okBody.database, "ok");
});
