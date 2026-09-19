// 極簡 HS256 JWT(簽/驗)。只用於 akentros_token cookie 的會話憑證,
// payload 固定為 { sub: userId, exp };不開放任意 claims。

const encoder = new TextEncoder();

interface AkentrosJwtPayload {
  sub: string;
  exp: number;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
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
  payload: { sub: string },
  secret: string,
  expiresInSeconds: number,
): Promise<string> {
  const header = toBase64Url(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const expires = Math.floor(Date.now() / 1000) + Math.max(60, Math.trunc(expiresInSeconds));
  const body = toBase64Url(encoder.encode(JSON.stringify({ sub: payload.sub, exp: expires })));
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
    payload = { sub: parsed.sub, exp: parsed.exp };
  } catch {
    return null;
  }
  if (payload.exp * 1000 <= Date.now()) return null;
  return payload;
}
