import { parseUsdToMicros, usdMicrosToDecimalString } from "@beacon/core/pricing";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createRateLimit } from "../middleware/rateLimit.ts";
import type { BeaconContext, BeaconEnv, BeaconNext, BeaconRuntimeEnv } from "../types.ts";
import { randomBytesHex } from "../utils/crypto.ts";
import { signBeaconJwt, verifyBeaconJwt } from "../utils/jwt.ts";
import type { BeaconAccount } from "../utils/users.ts";
import {
  BEACON_PASSWORD_ITERATIONS,
  createUser,
  findUserByEmail,
  findUserById,
  findUserPasswordHash,
  hashPassword,
  verifyPassword,
} from "../utils/users.ts";

// 內建帳號系統:會話端點 + authenticateToken/requireCsrfToken 中介層。
// 與前端的約定:
// - beacon_token:httpOnly 會話 cookie(authenticateToken 驗證)
// - csrf_token:可讀 cookie,apiFetch 會放進 X-CSRF-Token(雙提交)

export const authRoutes = new Hono<BeaconEnv>();

export const BEACON_SESSION_COOKIE = "beacon_token";
export const BEACON_CSRF_COOKIE = "csrf_token";
export const BEACON_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

// 開發者管理面的會話認證:驗 beacon_token cookie(HS256 JWT)→ 載入使用者 →
// c.set('user', …)。aiDeveloper.ts 依賴 user.id / role / is_banned /
// restricted_services 等欄位,形狀需與 utils/users.ts 的 BeaconAccount 一致。
export async function authenticateToken(c: BeaconContext, next: BeaconNext) {
  const secret = String(c.env?.JWT_SECRET || "");
  if (secret.length < 32) {
    return c.json(
      {
        error: "Authentication is temporarily unavailable.",
        code: "auth_configuration_unavailable",
      },
      503,
    );
  }

  const token = getCookie(c, BEACON_SESSION_COOKIE) || "";
  const payload = token ? await verifyBeaconJwt(token, secret) : null;
  if (!payload) {
    return c.json(
      {
        error: "Authentication required. Please sign in to continue.",
        code: "authentication_required",
      },
      401,
    );
  }

  const user = await findUserById(c.env, payload.sub);
  if (!user || user.is_banned) {
    return c.json(
      {
        error: "This account cannot use the developer console.",
        code: "access_denied",
      },
      403,
    );
  }

  c.set("user", user);
  await next();
}

// CSRF:雙提交 cookie。前端 apiFetch 會讀 csrf_token cookie 並帶 X-CSRF-Token。
// 沒有 csrf_token cookie 的請求(尚未取得 session 的 login/register)直接放行,
// 因為此時沒有可被冒用的憑證;取得 session 後所有 mutating 請求都會被要求比對。
export async function requireCsrfToken(c: BeaconContext, next: BeaconNext) {
  const method = c.req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    await next();
    return;
  }
  const cookieToken = getCookie(c, BEACON_CSRF_COOKIE) || "";
  if (!cookieToken) {
    await next();
    return;
  }
  const headerToken = String(c.req.header("X-CSRF-Token") || "");
  if (headerToken && timingSafeEqual(headerToken, cookieToken)) {
    await next();
    return;
  }
  return c.json(
    {
      error: "CSRF token is missing or invalid. Please refresh and try again.",
      code: "csrf_token_invalid",
    },
    403,
  );
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

const authLimiter = createRateLimit({
  keyPrefix: "beacon-auth",
  windowMs: 15 * 60 * 1000,
  max: 60,
  keyGenerator: beaconAuthRateLimitIdentity,
});

// auth 限流(登入/註冊/登出)的身份決定順序:
// 1. BEACON_TRUST_PROXY=true:明確宣告信任反向代理,以 cf-connecting-ip 標頭
//    為準。僅當 gateway 前方有會「覆寫」此標頭的受信賴代理(Cloudflare 等)
//    才應開啟。
// 2. 連線來源位址:Node 自架部署由 nodeServer 從 socket 注入
//    BEACON_REMOTE_ADDR,不可偽造,是未開啟信任代理時的預設身份。若直接
//    讀請求標頭,Node/http 不會過濾 cf-connecting-ip,攻擊者每個請求帶一個
//    不同的假 IP 即可完全繞過限流(無限暴力嘗試密碼、洗註冊附贈點數)。
// 3. Workers/DO 部署:流量一律經 Cloudflare 代理,標頭由其附加、用戶端
//    帶入的同名標頭會被覆蓋,且 runtime 內拿不到 socket 位址 → 以標頭為準。
// 4. 都拿不到(本地 IPC、Unix socket)併入 "local" 共享桶。
export function beaconAuthRateLimitIdentity(c: BeaconContext): string {
  const forwarded = String(c.req.header("cf-connecting-ip") || "").trim();
  if (
    String(c.env?.BEACON_TRUST_PROXY || "")
      .trim()
      .toLowerCase() === "true"
  ) {
    return forwarded || "local";
  }
  const remote = String((c.env as Record<string, unknown>)?.BEACON_REMOTE_ADDR || "").trim();
  if (remote) return remote;
  return forwarded || "local";
}

function isSecureRequest(c: BeaconContext): boolean {
  try {
    return (
      new URL(c.req.url).protocol === "https:" || String(c.req.header("x-forwarded-proto") || "") === "https"
    );
  } catch {
    return false;
  }
}

function requireJwtSecret(env: BeaconRuntimeEnv): string | null {
  const secret = String(env?.JWT_SECRET || "");
  return secret.length >= 32 ? secret : null;
}

function issueSession(c: BeaconContext, env: BeaconRuntimeEnv, userId: string) {
  const secret = requireJwtSecret(env);
  if (!secret) {
    return c.json(
      {
        error: "Authentication is temporarily unavailable.",
        code: "auth_configuration_unavailable",
      },
      503,
    );
  }
  return signBeaconJwt({ sub: userId }, secret, BEACON_SESSION_TTL_SECONDS).then((jwt) => {
    setCookie(c, BEACON_SESSION_COOKIE, jwt, {
      httpOnly: true,
      sameSite: "Lax",
      secure: isSecureRequest(c),
      path: "/",
      maxAge: BEACON_SESSION_TTL_SECONDS,
    });
    setCookie(c, BEACON_CSRF_COOKIE, randomBytesHex(32), {
      httpOnly: false,
      sameSite: "Lax",
      secure: isSecureRequest(c),
      path: "/",
      maxAge: BEACON_SESSION_TTL_SECONDS,
    });
  });
}

function registrationDisabled(env: BeaconRuntimeEnv): boolean {
  return (
    String(env?.BEACON_DISABLE_REGISTRATION || "")
      .trim()
      .toLowerCase() === "true"
  );
}

function signupBonusUsdMicros(env: BeaconRuntimeEnv): string {
  try {
    return parseUsdToMicros(env?.BEACON_SIGNUP_BONUS_USD ?? "5.00", "BEACON_SIGNUP_BONUS_USD").toString();
  } catch {
    return "5000000";
  }
}

function isUniqueEmailViolation(error: unknown): boolean {
  // 訊息比對覆蓋 node:sqlite 與 Workers storage.sql 的錯誤形狀
  // ("UNIQUE constraint failed: users.email")。
  const message = String((error as Error | undefined)?.message || "");
  return message.includes("UNIQUE constraint failed") && message.includes("users.email");
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

authRoutes.use("*", authLimiter);

authRoutes.post("/register", async (c: BeaconContext) => {
  if (registrationDisabled(c.env)) {
    return c.json(
      { error: "Registration is disabled on this deployment.", code: "registration_disabled" },
      403,
    );
  }
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "The request body is not valid JSON.", code: "invalid_request" }, 400);
  }
  const email = String(body?.email || "")
    .trim()
    .toLowerCase();
  const username = String(body?.username || "").trim();
  const password = String(body?.password || "");

  if (!EMAIL_PATTERN.test(email) || email.length > 254) {
    return c.json({ error: "A valid email address is required.", code: "invalid_email" }, 400);
  }
  if (username.length < 2 || username.length > 40) {
    return c.json({ error: "Username must be 2-40 characters.", code: "invalid_username" }, 400);
  }
  if (password.length < 8 || password.length > 200) {
    return c.json({ error: "Password must be at least 8 characters.", code: "invalid_password" }, 400);
  }
  if (await findUserByEmail(c.env, email)) {
    return c.json({ error: "This email is already registered.", code: "email_taken" }, 409);
  }

  const passwordHash = await hashPassword(password, c.env);
  let user: BeaconAccount;
  try {
    user = await createUser(c.env, {
      email,
      username,
      passwordHash,
      balanceUsdMicros: signupBonusUsdMicros(c.env),
    });
  } catch (error) {
    // 併發 race:兩個同信箱註冊都通過 findUserByEmail 檢查後,第二個 INSERT
    // 撞 UNIQUE(users.email) 約束。資料未損毀,語意仍是 email_taken → 409,
    // 不應落到 onError 變成 500。
    if (isUniqueEmailViolation(error)) {
      return c.json({ error: "This email is already registered.", code: "email_taken" }, 409);
    }
    throw error;
  }
  await issueSession(c, c.env, user.id);
  return c.json({ user: publicUser(user) }, 201);
});

authRoutes.post("/login", async (c: BeaconContext) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "The request body is not valid JSON.", code: "invalid_request" }, 400);
  }
  const email = String(body?.email || "")
    .trim()
    .toLowerCase();
  const password = String(body?.password || "");

  // 帳號不存在時仍執行一次雜湊驗證,讓回應時間不洩漏帳號存在性。
  // dummy hash 的迭代數必須跟著預設值走,兩條路徑的運算成本才會一致。
  const storedHash = await findUserPasswordHash(c.env, email);
  const passwordOk = await verifyPassword(
    password,
    storedHash || `pbkdf2$${BEACON_PASSWORD_ITERATIONS}$00$00`,
  );
  const user = passwordOk ? await findUserByEmail(c.env, email) : null;
  if (!user || user.is_banned || !passwordOk) {
    return c.json({ error: "Email or password is incorrect.", code: "invalid_credentials" }, 401);
  }

  await issueSession(c, c.env, user.id);
  return c.json({ user: publicUser(user) });
});

authRoutes.post("/logout", async (c: BeaconContext) => {
  deleteCookie(c, BEACON_SESSION_COOKIE, { path: "/" });
  deleteCookie(c, BEACON_CSRF_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

authRoutes.get("/me", authenticateToken, async (c: BeaconContext) => {
  // authenticateToken 已設 c.set('user', …);重新讀取以取得最新點數。
  const user = await findUserById(c.env, c.get("user")?.id || "");
  if (!user) return c.json({ error: "Account not found.", code: "user_not_found" }, 404);
  return c.json({ user: publicUser(user) });
});

function publicUser(user: BeaconAccount) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    display_name: user.display_name,
    role: user.role,
    balance_usd: usdMicrosToDecimalString(user.balanceUsdMicros || "0"),
  };
}
