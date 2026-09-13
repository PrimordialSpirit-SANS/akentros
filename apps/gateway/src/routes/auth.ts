import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { parseUsdToMicros, usdMicrosToDecimalString } from "../../../../packages/core/src/pricing.ts";
import { createRateLimit } from "../middleware/rateLimit.ts";
import { randomBytesHex } from "../utils/crypto.ts";
import { signBeaconJwt, verifyBeaconJwt } from "../utils/jwt.ts";
import {
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

export const authRoutes = new Hono();

export const BEACON_SESSION_COOKIE = "beacon_token";
export const BEACON_CSRF_COOKIE = "csrf_token";
export const BEACON_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

// 開發者管理面的會話認證:驗 beacon_token cookie(HS256 JWT)→ 載入使用者 →
// c.set('user', …)。aiDeveloper.ts 依賴 user.id / role / is_banned /
// restricted_services 等欄位,形狀需與 utils/users.ts 的 BeaconAccount 一致。
export async function authenticateToken(c: any, next: any) {
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
export async function requireCsrfToken(c: any, next: any) {
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
  keyGenerator: (c: any) => String(c.req.header("cf-connecting-ip") || "local"),
});

function isSecureRequest(c: any): boolean {
  try {
    return (
      new URL(c.req.url).protocol === "https:" || String(c.req.header("x-forwarded-proto") || "") === "https"
    );
  } catch {
    return false;
  }
}

function requireJwtSecret(env: any): string | null {
  const secret = String(env?.JWT_SECRET || "");
  return secret.length >= 32 ? secret : null;
}

function issueSession(c: any, env: any, userId: string) {
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

function registrationDisabled(env: any): boolean {
  return (
    String(env?.BEACON_DISABLE_REGISTRATION || "")
      .trim()
      .toLowerCase() === "true"
  );
}

function signupBonusUsdMicros(env: any): string {
  try {
    return parseUsdToMicros(env?.BEACON_SIGNUP_BONUS_USD ?? "5.00", "BEACON_SIGNUP_BONUS_USD").toString();
  } catch {
    return "5000000";
  }
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

authRoutes.use("*", authLimiter);

authRoutes.post("/register", async (c: any) => {
  if (registrationDisabled(c.env)) {
    return c.json(
      { error: "Registration is disabled on this deployment.", code: "registration_disabled" },
      403,
    );
  }
  let body: any;
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
  const user = await createUser(c.env, {
    email,
    username,
    passwordHash,
    balanceUsdMicros: signupBonusUsdMicros(c.env),
  });
  await issueSession(c, c.env, user.id);
  return c.json({ user: publicUser(user) }, 201);
});

authRoutes.post("/login", async (c: any) => {
  let body: any;
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
  const storedHash = await findUserPasswordHash(c.env, email);
  const passwordOk = await verifyPassword(password, storedHash || "pbkdf2$25000$00$00");
  const user = passwordOk ? await findUserByEmail(c.env, email) : null;
  if (!user || user.is_banned || !passwordOk) {
    return c.json({ error: "Email or password is incorrect.", code: "invalid_credentials" }, 401);
  }

  await issueSession(c, c.env, user.id);
  return c.json({ user: publicUser(user) });
});

authRoutes.post("/logout", async (c: any) => {
  deleteCookie(c, BEACON_SESSION_COOKIE, { path: "/" });
  deleteCookie(c, BEACON_CSRF_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

authRoutes.get("/me", authenticateToken, async (c: any) => {
  // authenticateToken 已設 c.set('user', …);重新讀取以取得最新點數。
  const user = await findUserById(c.env, c.get("user").id);
  if (!user) return c.json({ error: "Account not found.", code: "user_not_found" }, 404);
  return c.json({ user: publicUser(user) });
});

function publicUser(user: any) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    display_name: user.display_name,
    role: user.role,
    balance_usd: usdMicrosToDecimalString(user.balanceUsdMicros || "0"),
  };
}
