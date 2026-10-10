import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { createApp } from "../src/app.ts";
import { ensureAkentrosSchemaReady } from "../src/utils/bootstrap.ts";
import { dbQuery, installNodeAkentrosDbAdapter } from "../src/utils/db.ts";
import { signAkentrosJwt, verifyAkentrosJwt } from "../src/utils/jwt.ts";
import { revokeAkentrosSessions } from "../src/utils/users.ts";

// SEC-01(伺服端會話撤銷)的真實 DB 行為:
// - JWT 固定 claim epv 於簽發時綁定 users.session_epoch;
// - authenticateToken 每請求比對,epv !== session_epoch → 401 session_revoked;
// - 撤銷 = session_epoch + 1(revokeAkentrosSessions),無需輪替 JWT_SECRET;
// - 舊 token(無 epv)視為 0 —— 過渡期不自動登出既有用戶。
// 搭配 node:sqlite :memory: DB,與 signupEnumeration.test.ts 同一拓撲。

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

// 防枚舉模式下註冊不自動發 session,登入才是會話入口。
async function registerAndLogin(app: any, email: string, password: string) {
  const register = await app.request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, username: email.split("@")[0], password }),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(register.status, 202, "anti-enumeration register accepts");
  const login = await app.request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(login.status, 200, "login issues a session");
  const setCookie = login.headers.get("set-cookie") || "";
  const token = /akentros_token=([^;]+)/.exec(setCookie)?.[1] || "";
  assert.ok(token, "session cookie is present");
  return token;
}

function meRequest(token: string) {
  return {
    headers: { Cookie: `akentros_token=${token}` },
  };
}

// 以與 jwt.ts 相同的 HS256 演算法手工鑄造「v4 之前的舊 token」:
// payload 只有 { sub, exp },沒有 epv —— 模擬升級當下仍在瀏覽器裡的
// 既有會話,驗證過渡期「視為 0」的契約。
async function forgeLegacyJwt(sub: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const encode = (value: string) => btoa(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  const header = encode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = encode(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 60 * 60 }));
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`${header}.${body}`));
  const encodedSignature = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  return `${header}.${body}.${encodedSignature}`;
}

async function createUserRow(env: any, email: string) {
  const row = await dbQuery(
    env,
    "INSERT INTO users (username, email, password_hash, balance_usd_micros) VALUES (?, ?, 'x', 1000000) RETURNING id, session_epoch",
    [email.split("@")[0], email],
  );
  return { id: String(row.rows[0].id), sessionEpoch: Number(row.rows[0].session_epoch) };
}

// ── 驗收案例 1 + 2:epoch 不符 → 401;重新登入(epoch 相符)→ 通過 ──
test("revoked session tokens are rejected with 401; re-login on the new epoch passes", async () => {
  await installNodeAkentrosDbAdapter();
  const env = await createSchemaReadyEnv();
  const app = createTestApp(env);

  const email = "epoch-revoke@example.com";
  const token = await registerAndLogin(app, email, "longenough1");

  // 簽發即綁定當下 epoch(0):通過。
  const fresh = await app.request("/api/auth/me", meRequest(token));
  assert.equal(fresh.status, 200);
  assert.equal(((await fresh.json()) as any).user.email, email);

  // JWT 確實簽入 epv(固定第 3 claim,值 = 簽發時的 session_epoch)。
  const payload = await verifyAkentrosJwt(token, SECRET);
  assert.ok(payload, "token verifies against the test secret");
  assert.equal(payload?.epv, 0, "newly issued token carries epv = current epoch");

  // 撤銷全部會話:session_epoch + 1 → 舊 token 的 epv(0)不一致 → 401。
  const revocation = await revokeAkentrosSessions(env, { email });
  assert.equal(revocation.revoked, 1);
  const revokedResponse = await app.request("/api/auth/me", meRequest(token));
  assert.equal(revokedResponse.status, 401, "stale token is server-side revoked");
  const revokedBody = (await revokedResponse.json()) as any;
  assert.equal(revokedBody.code, "session_revoked");

  // 重新登入 → 新 token 簽入新 epoch(1)→ 通過(驗收:epoch 相符 → 通過)。
  const newToken = await registerAndLoginViaLogin(app, email, "longenough1");
  const reloginPayload = await verifyAkentrosJwt(newToken, SECRET);
  assert.equal(reloginPayload?.epv, 1, "re-login binds the bumped epoch");
  const afterRelogin = await app.request("/api/auth/me", meRequest(newToken));
  assert.equal(afterRelogin.status, 200);
  assert.equal(((await afterRelogin.json()) as any).user.email, email);
});

// registerAndLogin 的變體:帳號已存在,只走登入。
async function registerAndLoginViaLogin(app: any, email: string, password: string) {
  const login = await app.request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get("set-cookie") || "";
  const token = /akentros_token=([^;]+)/.exec(setCookie)?.[1] || "";
  assert.ok(token);
  return token;
}

// ── 驗收案例 3:無 epv 的舊 token → 視為 0 ──
test("legacy tokens without epv are treated as epoch 0 across the transition", async () => {
  await installNodeAkentrosDbAdapter();
  const env = await createSchemaReadyEnv();
  const app = createTestApp(env);

  // v4 之後才會有 session_epoch;直接建列(既有部署升級後既有用戶的形狀)。
  const { id } = await createUserRow(env, "legacy-user@example.com");
  assert.equal(
    Number((await dbQuery(env, "SELECT session_epoch FROM users WHERE id = ?", [id])).rows[0].session_epoch),
    0,
    "v4 default is 0",
  );

  // 舊 token(無 epv)對 epoch 0 的帳號:視為 0 → 相符 → 通過,不自動登出。
  const legacyToken = await forgeLegacyJwt(id, SECRET);
  const passes = await app.request("/api/auth/me", meRequest(legacyToken));
  assert.equal(passes.status, 200, "legacy token equals epoch 0 and stays valid");

  // 撤銷後帳號 epoch = 1:舊 token 仍視為 0 → 不相符 → 401。
  await revokeAkentrosSessions(env, { userId: id });
  const rejected = await app.request("/api/auth/me", meRequest(legacyToken));
  assert.equal(rejected.status, 401, "legacy token is revoked once the account epoch moves");
  assert.equal(((await rejected.json()) as any).code, "session_revoked");
});

// ── 撤銷函式的範圍語意:單一帳號 vs 全站 ──
test("revokeAkentrosSessions scopes per account and reports matched rows", async () => {
  await installNodeAkentrosDbAdapter();
  const env = await createSchemaReadyEnv();

  const alice = await createUserRow(env, "alice-scope@example.com");
  const bob = await createUserRow(env, "bob-scope@example.com");
  await createUserRow(env, "carol-scope@example.com");

  // 依 email 撤銷:只影響該帳號。
  const byEmail = await revokeAkentrosSessions(env, { email: "ALICE-scope@example.com" });
  assert.equal(byEmail.revoked, 1, "email match is case-insensitive");
  const aliceAfter = await dbQuery(env, "SELECT session_epoch FROM users WHERE id = ?", [alice.id]);
  const bobAfter = await dbQuery(env, "SELECT session_epoch FROM users WHERE id = ?", [bob.id]);
  assert.equal(Number(aliceAfter.rows[0].session_epoch), 1);
  assert.equal(Number(bobAfter.rows[0].session_epoch), 0, "other accounts untouched");

  // 依 id 撤銷:目標帳號再 +1;不存在的 id 回 0。
  const byId = await revokeAkentrosSessions(env, { userId: alice.id });
  assert.equal(byId.revoked, 1);
  const aliceAgain = await dbQuery(env, "SELECT session_epoch FROM users WHERE id = ?", [alice.id]);
  assert.equal(Number(aliceAgain.rows[0].session_epoch), 2);
  const missing = await revokeAkentrosSessions(env, { userId: "999999" });
  assert.equal(missing.revoked, 0);

  // 全站撤銷:所有帳號同步 +1,回傳受影響列數。
  const totalBefore = await dbQuery(env, "SELECT COUNT(*) AS total FROM users");
  const all = await revokeAkentrosSessions(env, { all: true });
  assert.equal(all.revoked, Number(totalBefore.rows[0].total));
  const bobFinal = await dbQuery(env, "SELECT session_epoch FROM users WHERE id = ?", [bob.id]);
  assert.equal(Number(bobFinal.rows[0].session_epoch), 1);

  // 非法輸入 fail-fast。
  await assert.rejects(revokeAkentrosSessions(env, {} as any), TypeError);
  await assert.rejects(revokeAkentrosSessions(env, { userId: "not-a-number" }), TypeError);
});

// ── epv 的解析契約(維持「不開放任意 claims」) ──
test("jwt epv roundtrip keeps the fixed-claim contract strict", async () => {
  const secret = "y".repeat(32);

  // 簽入/回傳 roundtrip。
  const token = await signAkentrosJwt({ sub: "7", epv: 3 }, secret, 60);
  const payload = await verifyAkentrosJwt(token, secret);
  assert.equal(payload?.sub, "7");
  assert.equal(payload?.epv, 3);

  // 不帶 epv 的簽入(舊契約形狀)→ 回傳 undefined,呼叫端視為 0。
  const legacy = await signAkentrosJwt({ sub: "7" }, secret, 60);
  const legacyPayload = await verifyAkentrosJwt(legacy, secret);
  assert.equal(legacyPayload?.epv, undefined);
  assert.equal(legacyPayload?.epv ?? 0, 0);

  // 偽造/畸形 epv(簽名有效但值非法):整權杖無效 —— 嚴格解析、fail-closed。
  const encoder = new TextEncoder();
  const encode = (value: string) => btoa(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  const header = encode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  for (const bad of [{ epv: -1 }, { epv: 1.5 }, { epv: "1" }]) {
    const body = encode(JSON.stringify({ sub: "7", exp: Math.floor(Date.now() / 1000) + 3600, ...bad }));
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`${header}.${body}`));
    const encodedSignature = btoa(String.fromCharCode(...new Uint8Array(signature)))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
    const forged = `${header}.${body}.${encodedSignature}`;
    assert.equal(
      await verifyAkentrosJwt(forged, secret),
      null,
      `malformed epv ${JSON.stringify(bad.epv)} must invalidate the token`,
    );
  }
});
