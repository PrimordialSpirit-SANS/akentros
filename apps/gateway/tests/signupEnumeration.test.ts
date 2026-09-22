import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { createApp } from "../src/app.ts";
import { ensureAkentrosSchemaReady } from "../src/utils/bootstrap.ts";
import { installNodeAkentrosDbAdapter } from "../src/utils/db.ts";

// 註冊防帳號枚舉的真實 DB 行為(時序等化 + 重複信箱隱匿):
// - 預設:重複信箱回 202 受理訊息,不發 session、不揭露 email_taken。
// - AKENTROS_SIGNUP_ANTI_ENUMERATION=false:私有部署可還原明確 409 合約。
// 搭配 node:sqlite :memory: DB,與 bootstrap.test.ts 同一拓撲。

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

async function createSchemaReadyEnv(extra: Record<string, unknown> = {}) {
  const env: any = {
    AKENTROS_ENABLED: "true",
    JWT_SECRET: SECRET,
    AKENTROS_DB_PATH: ":memory:",
    ...extra,
  };
  await ensureAkentrosSchemaReady(env);
  return env;
}

function registerRequest(email: string, username: string, password: string) {
  return {
    method: "POST",
    body: JSON.stringify({ email, username, password }),
    headers: { "Content-Type": "application/json" },
  };
}

test("duplicate signup is concealed behind an accepted 202 response by default", async () => {
  await installNodeAkentrosDbAdapter();
  const env = await createSchemaReadyEnv();
  const app = createTestApp(env);

  const first = await app.request(
    "/api/auth/register",
    registerRequest("taken@example.com", "alice", "longenough1"),
  );
  assert.equal(first.status, 201);
  const firstBody = (await first.json()) as any;
  assert.ok(firstBody.user, "fresh signup returns the created user");
  assert.ok(
    first.headers.get("set-cookie")?.includes("akentros_token="),
    "fresh signup issues a session cookie",
  );

  const duplicate = await app.request(
    "/api/auth/register",
    registerRequest("taken@example.com", "mallory", "longenough2"),
  );
  assert.equal(duplicate.status, 202);
  const duplicateBody = (await duplicate.json()) as any;
  assert.equal(duplicateBody.ok, true);
  assert.equal(duplicateBody.user, undefined, "concealed response must not leak the account");
  assert.equal(duplicateBody.code, undefined, "concealed response must not expose email_taken");
  assert.equal(duplicate.headers.get("set-cookie"), null, "concealed response must not issue a session");
});

test("AKENTROS_SIGNUP_ANTI_ENUMERATION=false restores the explicit 409 contract", async () => {
  await installNodeAkentrosDbAdapter();
  const env = await createSchemaReadyEnv({ AKENTROS_SIGNUP_ANTI_ENUMERATION: "false" });
  const app = createTestApp(env);

  const first = await app.request(
    "/api/auth/register",
    registerRequest("explicit@example.com", "bob", "longenough1"),
  );
  assert.equal(first.status, 201);

  const duplicate = await app.request(
    "/api/auth/register",
    registerRequest("explicit@example.com", "mallory", "longenough2"),
  );
  assert.equal(duplicate.status, 409);
  assert.equal(((await duplicate.json()) as any).code, "email_taken");
});

test("concealed duplicate signup does not alter or take over the existing account", async () => {
  await installNodeAkentrosDbAdapter();
  const env = await createSchemaReadyEnv();
  const app = createTestApp(env);

  const first = await app.request(
    "/api/auth/register",
    registerRequest("owner@example.com", "owner", "ownerpass99"),
  );
  assert.equal(first.status, 201);

  const probe = await app.request(
    "/api/auth/register",
    registerRequest("owner@example.com", "attacker", "attackerpass1"),
  );
  assert.equal(probe.status, 202);

  // 攻擊者的密碼不得覆寫既有帳號:僅原密碼能登入。
  const stolenLogin = await app.request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: "owner@example.com", password: "attackerpass1" }),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(stolenLogin.status, 401);

  const ownerLogin = await app.request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: "owner@example.com", password: "ownerpass99" }),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(ownerLogin.status, 200);
  const ownerBody = (await ownerLogin.json()) as any;
  assert.equal(ownerBody.user.username, "owner", "account identity is unchanged");
});
