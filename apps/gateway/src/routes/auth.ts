import { AkentrosError } from "@akentros/core/openaiErrors";
import { parseUsdToMicros, usdMicrosToDecimalString } from "@akentros/core/pricing";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { isCredentialedOriginAllowed } from "../middleware/cors.ts";
import { createRateLimit } from "../middleware/rateLimit.ts";
import type { AkentrosContext, AkentrosEnv, AkentrosNext, AkentrosRuntimeEnv } from "../types.ts";
import { AKENTROS_SMALL_BODY_MAX_BYTES, readCappedText } from "../utils/bodyLimit.ts";
import { randomBytesHex } from "../utils/crypto.ts";
import { signAkentrosJwt, verifyAkentrosJwt } from "../utils/jwt.ts";
import { logAkentrosEvent } from "../utils/logger.ts";
import type { AkentrosAccount } from "../utils/users.ts";
import {
  AKENTROS_PASSWORD_ITERATIONS,
  createUser,
  findUserByEmail,
  findUserById,
  findUserPasswordHash,
  hashPassword,
  verifyPassword,
} from "../utils/users.ts";

// 內建帳號系統:會話端點 + authenticateToken/requireCsrfToken 中介層。
// 與前端的約定:
// - akentros_token:httpOnly 會話 cookie(authenticateToken 驗證)
// - csrf_token:可讀 cookie,apiFetch 會放進 X-CSRF-Token(雙提交)

export const authRoutes = new Hono<AkentrosEnv>();

export const AKENTROS_SESSION_COOKIE = "akentros_token";
export const AKENTROS_CSRF_COOKIE = "csrf_token";
export const AKENTROS_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

// 開發者管理面的會話認證:驗 akentros_token cookie(HS256 JWT)→ 載入使用者 →
// c.set('user', …)。aiDeveloper.ts 依賴 user.id / role / is_banned /
// restricted_services 等欄位,形狀需與 utils/users.ts 的 AkentrosAccount 一致。
export async function authenticateToken(c: AkentrosContext, next: AkentrosNext) {
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

  const token = getCookie(c, AKENTROS_SESSION_COOKIE) || "";
  const payload = token ? await verifyAkentrosJwt(token, secret) : null;
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
export async function requireCsrfToken(c: AkentrosContext, next: AkentrosNext) {
  const method = c.req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    await next();
    return;
  }
  const cookieToken = getCookie(c, AKENTROS_CSRF_COOKIE) || "";
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

// ── Pre-auth 的 CSRF 緩解:Origin/Referer 檢查 ─────────────────────────────
// requireCsrfToken 的雙提交 cookie 只保護「已取得 session」後的 mutating 請求;
// login/register 本身沒有 csrf cookie 可提交,而 SameSite=Lax 擋不了 login
// CSRF —— session cookie 是由「回應」設定的:攻擊者以隱藏表單把自己的憑證
// 送進受害者的瀏覽器,受害者就被靜默登入攻擊者帳號(供攻擊者側錄後續操作)。
// 瀏覽器對所有跨來源 POST 一律附帶 Origin 標頭,因此:
// - Origin(或 Referer 的 origin)存在、但既非同源也不在 CORS 白名單 → 403;
// - 兩者皆缺 → 放行:這是非瀏覽器客戶端(curl、SDK)的正常形狀,而 CSRF
//   威脅模型只存在於瀏覽器。
// 與 cors.ts 共用 isCredentialedOriginAllowed,確保「可跨來源帶憑證請求的
// 來源」與「可提交登入表單的來源」永遠是同一份名單,不會漂移。

// 代理鏈標頭可能是逗號清單(「客戶端, 代理」)。append 模式的代理把
// 自己的觀察值附加在尾端,首值是客戶端可注入側;SN-6 fix:一律取
// 最後一值(最接近受信代理的觀察),避免攻擊者注入 x-forwarded-host
// 偽造「同源」誤導 pre-auth 登入的 CSRF 同源判定。
function lastForwardedValue(value: unknown): string {
  const parts = String(value || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : "";
}

// 明確宣告信任反向代理:運維承諾 gateway 前方有會「覆寫」cf-connecting-ip
// 與 x-forwarded-* 的受信賴代理(Cloudflare、nginx 等),因此客戶端帶入的
// 同名標頭不會存活到 gateway。與 akentrosAuthRateLimitIdentity 共用同一個
// 定義,讓信任邊界只有一處語意。
function akentrosTrustProxyEnabled(c: AkentrosContext): boolean {
  return (
    String(c.env?.AKENTROS_TRUST_PROXY || "")
      .trim()
      .toLowerCase() === "true"
  );
}

function requestOwnOrigin(c: AkentrosContext): string {
  // TLS 終止的反向代理後方,c.req.url 的 scheme 仍是 socket 的 http:
  // (@hono/node-server 只在 socket 加密時才解析出 https),瀏覽器的
  // Origin 卻是 https://…,逐字串比對會把「同源」誤判成跨源。宣告信任
  // 代理時改以 x-forwarded-proto/x-forwarded-host 重建自身來源;未宣告時
  // 這些標頭可偽造、一律不信,維持 socket URL。
  if (akentrosTrustProxyEnabled(c)) {
    const proto = lastForwardedValue(c.req.header("x-forwarded-proto"));
    const host = lastForwardedValue(c.req.header("x-forwarded-host"));
    if (proto && host) {
      try {
        return new URL(`${proto}://${host}`).origin;
      } catch {
        // 不成形的標頭組合:退回 socket URL,同源判定自然不成立。
      }
    }
  }
  try {
    return new URL(c.req.url).origin;
  } catch {
    return "";
  }
}

// Origin 優先;缺少時退回 Referer 的 origin(scheme://host:port)。
// 無法解析的 Referer 視同未提供 —— 跨站 POST 在現代瀏覽器必定帶 Origin,
// 走不到這條退路。
function readDeclaredOrigin(c: AkentrosContext): string {
  const origin = String(c.req.header("origin") || "").trim();
  if (origin) return origin;
  const referer = String(c.req.header("referer") || "").trim();
  if (!referer) return "";
  try {
    return new URL(referer).origin;
  } catch {
    return "";
  }
}

export async function requireTrustedOrigin(c: AkentrosContext, next: AkentrosNext) {
  const method = c.req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    await next();
    return;
  }
  const declared = readDeclaredOrigin(c);
  if (!declared) {
    await next();
    return;
  }
  // 「null」origin(沙箱 iframe)無法與任何部署同源,白名單檢查自然拒絕。
  const trusted = declared === requestOwnOrigin(c) || isCredentialedOriginAllowed(c, declared);
  if (!trusted) {
    logAkentrosEvent("warn", "akentros_auth_origin_rejected", {
      method,
      path: c.req.path,
    });
    return c.json(
      {
        error: "Requests from this origin are not allowed.",
        code: "origin_forbidden",
      },
      403,
    );
  }
  await next();
}

const authLimiter = createRateLimit({
  keyPrefix: "akentros-auth",
  windowMs: 15 * 60 * 1000,
  max: 60,
  keyGenerator: akentrosAuthRateLimitIdentity,
});

// auth 限流(登入/註冊/登出)的身份決定順序:
// 1. AKENTROS_TRUST_PROXY=true:明確宣告信任反向代理,以 cf-connecting-ip 標頭
//    為準,其次 x-forwarded-for 最後一值(append 模式代理最接近受信方的
//    觀察;SN-2 fix:不設 cf-connecting-ip 的 nginx 類代理不再讓全站退化
//    為單一 "local" 共享桶 —— 60 次/15 分鐘就能鎖死所有真實用戶的登入)。
// 2. 連線來源位址:Node 自架部署由 nodeServer 從 socket 注入
//    AKENTROS_REMOTE_ADDR,不可偽造,是未開啟信任代理時的預設身份。若直接
//    讀請求標頭,Node/http 不會過濾 cf-connecting-ip,攻擊者每個請求帶一個
//    不同的假 IP 即可完全繞過限流(無限暴力嘗試密碼、洗註冊附贈點數)。
// 3. Workers/DO 部署:流量一律經 Cloudflare 代理,標頭由其附加、用戶端
//    帶入的同名標頭會被覆蓋,且 runtime 內拿不到 socket 位址 → 以標頭為準。
// 4. 都拿不到(本地 IPC、Unix socket)併入 "local" 共享桶,並對運維發出
//    一次性告警(每種退化成因只記一次,避免刷屏)。
let authRateLimitDegradedNotified = false;
export function akentrosAuthRateLimitIdentity(c: AkentrosContext): string {
  const cfIp = String(c.req.header("cf-connecting-ip") || "").trim();
  const remote = String((c.env as Record<string, unknown>)?.AKENTROS_REMOTE_ADDR || "").trim();
  if (akentrosTrustProxyEnabled(c)) {
    if (cfIp) return cfIp;
    const forwardedFor = lastForwardedValue(c.req.header("x-forwarded-for"));
    if (forwardedFor) return `xff:${forwardedFor}`;
    if (remote) return remote;
  } else if (remote) {
    return remote;
  }
  if (cfIp && !akentrosTrustProxyEnabled(c)) return cfIp;
  if (!authRateLimitDegradedNotified) {
    authRateLimitDegradedNotified = true;
    logAkentrosEvent("warn", "akentros_auth_rate_limit_identity_degraded", {
      trustProxy: akentrosTrustProxyEnabled(c),
      hint: "auth rate limiting fell back to a shared bucket; set AKENTROS_TRUST_PROXY=true behind a trusted reverse proxy that overwrites identity headers, or expose the socket address.",
    });
  }
  return "local";
}

function isSecureRequest(c: AkentrosContext): boolean {
  try {
    if (new URL(c.req.url).protocol === "https:") return true;
    // SN-5 fix:僅在明確宣告信任代理時採信 x-forwarded-proto,與
    // requestOwnOrigin 的信任邊界一致;未宣告時該標頭可偽造(純 HTTP
    // 下偽造 https 可翻轉 cookie 的 Secure 屬性),一律不信。
    if (!akentrosTrustProxyEnabled(c)) return false;
    return lastForwardedValue(c.req.header("x-forwarded-proto")) === "https";
  } catch {
    return false;
  }
}

function requireJwtSecret(env: AkentrosRuntimeEnv): string | null {
  const secret = String(env?.JWT_SECRET || "");
  return secret.length >= 32 ? secret : null;
}

function issueSession(c: AkentrosContext, env: AkentrosRuntimeEnv, userId: string) {
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
  return signAkentrosJwt({ sub: userId }, secret, AKENTROS_SESSION_TTL_SECONDS).then((jwt) => {
    setCookie(c, AKENTROS_SESSION_COOKIE, jwt, {
      httpOnly: true,
      sameSite: "Lax",
      secure: isSecureRequest(c),
      path: "/",
      maxAge: AKENTROS_SESSION_TTL_SECONDS,
    });
    setCookie(c, AKENTROS_CSRF_COOKIE, randomBytesHex(32), {
      httpOnly: false,
      sameSite: "Lax",
      secure: isSecureRequest(c),
      path: "/",
      maxAge: AKENTROS_SESSION_TTL_SECONDS,
    });
  });
}

function registrationDisabled(env: AkentrosRuntimeEnv): boolean {
  return (
    String(env?.AKENTROS_DISABLE_REGISTRATION || "")
      .trim()
      .toLowerCase() === "true"
  );
}

function signupBonusUsdMicros(env: AkentrosRuntimeEnv): string {
  try {
    return parseUsdToMicros(env?.AKENTROS_SIGNUP_BONUS_USD ?? "5.00", "AKENTROS_SIGNUP_BONUS_USD").toString();
  } catch {
    return "5000000";
  }
}

// 防帳號枚舉(預設開啟):重複信箱註冊不再回 409 email_taken,改為「已受理」
// 語意,回應本身不洩漏信箱是否已註冊。私有、僅內部可達的部署若需要明確的
// 409 UX,可設 AKENTROS_SIGNUP_ANTI_ENUMERATION=false 還原。
function signupAntiEnumeration(env: AkentrosRuntimeEnv): boolean {
  return (
    String(env?.AKENTROS_SIGNUP_ANTI_ENUMERATION || "")
      .trim()
      .toLowerCase() !== "false"
  );
}

// 防枚舉模式下,新註冊與重複信箱共用同一個 202 受理回應:狀態碼、主體、
// cookie 三者完全一致,回應端不存在任何可區分「信箱是否已註冊」的訊號
// (201 vs 202 的差異本身就是枚舉 oracle)。每次探測都付出 PBKDF2 成本並
// 消耗登入/註冊限流額度;受理後不自動登入,請使用者改走登入流程。
const SIGNUP_ACCEPTED_MESSAGE =
  "Registration accepted. If the email is available, the account has been created — please sign in.";

function acceptedSignupResponse(c: AkentrosContext) {
  return c.json({ ok: true, message: SIGNUP_ACCEPTED_MESSAGE }, 202);
}

function concealedSignupResponse(c: AkentrosContext) {
  // 營運可觀測性:回應不揭露,但伺服器日誌保留隱匿的重複註冊事件。
  logAkentrosEvent("warn", "akentros_signup_duplicate_concealed");
  return acceptedSignupResponse(c);
}

function isUniqueEmailViolation(error: unknown): boolean {
  // 訊息比對覆蓋 node:sqlite 與 Workers storage.sql 的錯誤形狀
  // ("UNIQUE constraint failed: users.email")。
  const message = String((error as Error | undefined)?.message || "");
  return message.includes("UNIQUE constraint failed") && message.includes("users.email");
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// 使用者名稱字元禁則:控制字元(C0/C1、DEL)、行/段落分隔符、軟連字號、
// 零寬字元、雙向覆寫控制符(含 ALM)、蒙古語母音分隔符、不可見運算子與
// 淘汰控制符(u2060-206F)、BOM。輸出端雖已全面轉義,這些字元仍會污染
// 結構化日誌與清單 UI 的視覺判讀,且零寬/雙向字元可用於帳號仿冒(在使用者
// 名稱中插入零寬空格或 RLO 覆寫來假冒他人)。長度檢查之外補上字元禁則,
// 讓髒輸入在觸庫前就被擋下;其餘可見字元(含 CJK、單碼點表情符號)不設限
// —— ZWJ(u200D)落在 u200B-u200F 禁區,組合式表情(家庭、職業等)因此
// 一併排除:ZWJ 本身是不可見連接符,允許它等於重開仿冒面,取捨上禁則優先。
const USERNAME_FORBIDDEN_PATTERN =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the denylist is the point - it rejects control, separator and invisible-spoofing characters in usernames
  /[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u206F\uFEFF]/;

// 登入/註冊承載遠小於 16KB;以串流計數上限讀取(Content-Length 預檢 + 逐塊
// 硬上限)。這是未認證即可觸達的端點,不接受 Hono json() 的全量緩衝。
type AuthJsonResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: 400 | 413; code: string; message: string };

async function readAuthJsonObject(c: AkentrosContext): Promise<AuthJsonResult> {
  let text: string;
  try {
    text = await readCappedText(c, AKENTROS_SMALL_BODY_MAX_BYTES);
  } catch (error) {
    if (error instanceof AkentrosError && error.status === 413) {
      return { ok: false, status: 413, code: "request_too_large", message: "The request body is too large." };
    }
    return {
      ok: false,
      status: 400,
      code: "invalid_request",
      message: "The request body is not valid JSON.",
    };
  }
  try {
    const parsed = text ? JSON.parse(text) : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        ok: false,
        status: 400,
        code: "invalid_request",
        message: "The request body is not valid JSON.",
      };
    }
    return { ok: true, body: parsed as Record<string, unknown> };
  } catch {
    return {
      ok: false,
      status: 400,
      code: "invalid_request",
      message: "The request body is not valid JSON.",
    };
  }
}

authRoutes.use("*", authLimiter);
authRoutes.use("*", requireTrustedOrigin);

authRoutes.post("/register", async (c: AkentrosContext) => {
  if (registrationDisabled(c.env)) {
    return c.json(
      { error: "Registration is disabled on this deployment.", code: "registration_disabled" },
      403,
    );
  }
  const parsedBody = await readAuthJsonObject(c);
  if (!parsedBody.ok) {
    return c.json({ error: parsedBody.message, code: parsedBody.code }, parsedBody.status);
  }
  const body = parsedBody.body;
  const email = String(body?.email || "")
    .trim()
    .toLowerCase();
  const username = String(body?.username || "").trim();
  const password = String(body?.password || "");

  if (!EMAIL_PATTERN.test(email) || email.length > 254) {
    return c.json({ error: "A valid email address is required.", code: "invalid_email" }, 400);
  }
  if (username.length < 2 || username.length > 40 || USERNAME_FORBIDDEN_PATTERN.test(username)) {
    return c.json(
      {
        error: "Username must be 2-40 characters and may not contain control or invisible characters.",
        code: "invalid_username",
      },
      400,
    );
  }
  if (password.length < 8 || password.length > 200) {
    return c.json({ error: "Password must be at least 8 characters.", code: "invalid_password" }, 400);
  }
  // 時序等化:不論信箱是否已註冊,一律先付出 PBKDF2 成本再查庫,回應時間
  // 不洩漏帳號存在性(與 login 的 dummy-hash 手法同一目的)。
  const passwordHash = await hashPassword(password, c.env);
  if (await findUserByEmail(c.env, email)) {
    if (signupAntiEnumeration(c.env)) {
      return concealedSignupResponse(c);
    }
    return c.json({ error: "This email is already registered.", code: "email_taken" }, 409);
  }

  let user: AkentrosAccount;
  try {
    user = await createUser(c.env, {
      email,
      username,
      passwordHash,
      balanceUsdMicros: signupBonusUsdMicros(c.env),
    });
  } catch (error) {
    // 併發 race:兩個同信箱註冊都通過 findUserByEmail 檢查後,第二個 INSERT
    // 撞 UNIQUE(users.email) 約束。資料未損毀,語意仍是重複信箱:走同一條
    // 隱匿/409 分支,不應落到 onError 變成 500。
    if (isUniqueEmailViolation(error)) {
      if (signupAntiEnumeration(c.env)) {
        return concealedSignupResponse(c);
      }
      return c.json({ error: "This email is already registered.", code: "email_taken" }, 409);
    }
    throw error;
  }
  if (signupAntiEnumeration(c.env)) {
    // 新註冊與重複信箱必須回應同形:201(+user+session)與 202 的狀態碼差異
    // 本身就是「信箱已註冊」的枚舉 oracle,違反 README 承諾的「不可區分」。
    // 防枚舉模式下不自動登入,受理後請使用者以註冊憑證登入(前端已支援此流程)。
    return acceptedSignupResponse(c);
  }
  await issueSession(c, c.env, user.id);
  return c.json({ user: publicUser(user) }, 201);
});

authRoutes.post("/login", async (c: AkentrosContext) => {
  const parsedBody = await readAuthJsonObject(c);
  if (!parsedBody.ok) {
    return c.json({ error: parsedBody.message, code: parsedBody.code }, parsedBody.status);
  }
  const body = parsedBody.body;
  const email = String(body?.email || "")
    .trim()
    .toLowerCase();
  const password = String(body?.password || "");

  // 帳號不存在時仍執行一次雜湊驗證,讓回應時間不洩漏帳號存在性。
  // dummy hash 的迭代數必須跟著預設值走,兩條路徑的運算成本才會一致。
  const storedHash = await findUserPasswordHash(c.env, email);
  const passwordOk = await verifyPassword(
    password,
    storedHash || `pbkdf2$${AKENTROS_PASSWORD_ITERATIONS}$00$00`,
  );
  const user = passwordOk ? await findUserByEmail(c.env, email) : null;
  if (!user || user.is_banned || !passwordOk) {
    return c.json({ error: "Email or password is incorrect.", code: "invalid_credentials" }, 401);
  }

  await issueSession(c, c.env, user.id);
  return c.json({ user: publicUser(user) });
});

authRoutes.post("/logout", async (c: AkentrosContext) => {
  deleteCookie(c, AKENTROS_SESSION_COOKIE, { path: "/" });
  deleteCookie(c, AKENTROS_CSRF_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

authRoutes.get("/me", authenticateToken, async (c: AkentrosContext) => {
  // authenticateToken 已設 c.set('user', …);重新讀取以取得最新點數。
  const user = await findUserById(c.env, c.get("user")?.id || "");
  if (!user) return c.json({ error: "Account not found.", code: "user_not_found" }, 404);
  return c.json({ user: publicUser(user) });
});

function publicUser(user: AkentrosAccount) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    display_name: user.display_name,
    role: user.role,
    balance_usd: usdMicrosToDecimalString(user.balanceUsdMicros || "0"),
  };
}
