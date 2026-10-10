// 極簡 HS256 JWT(簽/驗)。只用於 akentros_token cookie 的會話憑證,
// payload 固定為 { sub: userId, exp, epv };不開放任意 claims。
// epv(session epoch,SEC-01 fix):簽發時綁定的帳號會話 epoch 計數,
// authenticateToken 與 users.session_epoch 比對,不一致即 401 ——
// 伺服端會話撤銷的鉤子。舊 token 無此欄位 → 視為 0(過渡期不自動登出)。

const encoder = new TextEncoder();

export interface AkentrosJwtPayload {
  sub: string;
  exp: number;
  /** 會話 epoch;舊 token 未簽入此欄位(undefined → 呼叫端視為 0)。 */
  epv?: number;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function hmacKey(secret: string) {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export async function signAkentrosJwt(
  payload: { sub: string; epv?: number },
  secret: string,
  expiresInSeconds: number,
): Promise<string> {
  const header = toBase64Url(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const expires = Math.floor(Date.now() / 1000) + Math.max(60, Math.trunc(expiresInSeconds));
  const claims: { sub: string; exp: number; epv?: number } = { sub: payload.sub, exp: expires };
  // epv 是唯一新增的固定 claim;非法形狀(非安全整數/負數)一律省略,
  // 等同舊契約形狀,由驗證端的嚴格解析把關。
  if (typeof payload.epv === "number" && Number.isSafeInteger(payload.epv) && payload.epv >= 0) {
    claims.epv = payload.epv;
  }
  const body = toBase64Url(encoder.encode(JSON.stringify(claims)));
  const signingInput = `${header}.${body}`;
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(signingInput));
  return `${signingInput}.${toBase64Url(new Uint8Array(signature))}`;
}

export async function verifyAkentrosJwt(token: string, secret: string): Promise<AkentrosJwtPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts;
  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      fromBase64Url(signature),
      encoder.encode(`${header}.${body}`),
    );
  } catch {
    return null;
  }
  if (!valid) return null;

  let payload: AkentrosJwtPayload;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(body)));
    if (!parsed || typeof parsed.sub !== "string" || !/^[1-9][0-9]*$/.test(parsed.sub)) return null;
    if (typeof parsed.exp !== "number") return null;
    // epv 與 sub/exp 同級的嚴格解析:存在時必須是非負安全整數,否則整權杖
    // 視為無效(fail-closed);不存在 → 舊 token,回傳後由呼叫端視為 0。
    if (
      parsed.epv !== undefined &&
      (typeof parsed.epv !== "number" || !Number.isSafeInteger(parsed.epv) || parsed.epv < 0)
    ) {
      return null;
    }
    payload = { sub: parsed.sub, exp: parsed.exp };
    if (typeof parsed.epv === "number") payload.epv = parsed.epv;
  } catch {
    return null;
  }
  if (payload.exp * 1000 <= Date.now()) return null;
  return payload;
}
