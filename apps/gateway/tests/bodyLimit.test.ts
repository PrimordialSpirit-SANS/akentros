import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { AKENTROS_SMALL_BODY_MAX_BYTES, readCappedText } from "../src/utils/bodyLimit.ts";
import { readJsonObject } from "../src/utils/request.ts";

// 請求體上限:Content-Length 預檢 + 串流逐塊計數。Hono 的 json()/text() 會
// 先全量緩衝,超大請求體會在驗證前吃掉記憶體;此處釘死三條路徑的行為。

function appWith(handler: (c: any) => Promise<Response>) {
  const app = new Hono();
  app.post("/", (c: any) => handler(c));
  // 對齊 app.ts 的 onError:AkentrosError 以其 status 回應(413 等由 sendOpenAiError 送出)。
  app.onError((error: any, c: any) =>
    c.json({ message: error?.message, code: error?.code }, error?.status || 500),
  );
  return app;
}

test("content-length precheck rejects oversized bodies before streaming", async () => {
  const app = appWith((c) => readCappedText(c, AKENTROS_SMALL_BODY_MAX_BYTES).then((text) => c.text(text)));
  const response = await app.request("/", {
    method: "POST",
    headers: { "content-length": String(AKENTROS_SMALL_BODY_MAX_BYTES + 1) },
    body: "x",
  });
  assert.equal(response.status, 413);
});

test("chunked bodies over the cap are rejected mid-stream", async () => {
  const app = appWith((c) => readCappedText(c, 16).then((text) => c.text(text)));
  // 不帶 Content-Length(模擬 chunked/謊報的客戶端),實際串流 64 bytes。
  const response = await app.request("/", {
    method: "POST",
    body: "y".repeat(64),
    duplex: "half",
  } as RequestInit);
  assert.equal(response.status, 413);
});

test("bodies within the cap are read fully", async () => {
  const app = appWith((c) => readCappedText(c, 16).then((text) => c.json({ ok: true, length: text.length })));
  const response = await app.request("/", { method: "POST", body: "z".repeat(10) });
  assert.equal(response.status, 200);
  const payload: any = await response.json();
  assert.equal(payload.length, 10);
});

test("developer readJsonObject caps the body and maps size errors to 400 REQUEST_BODY_TOO_LARGE", async () => {
  const app = appWith(async (c) => {
    try {
      const body = await readJsonObject(c, { maxBytes: 16 });
      return c.json({ ok: true, name: body.name ?? null });
    } catch (error) {
      return c.json({ code: (error as any).code }, 400);
    }
  });

  const ok = await app.request("/", { method: "POST", body: JSON.stringify({ name: "key" }) });
  assert.equal(ok.status, 200);

  const tooLarge = await app.request("/", { method: "POST", body: JSON.stringify({ name: "k".repeat(64) }) });
  assert.equal(tooLarge.status, 400);
  const payload: any = await tooLarge.json();
  assert.equal(payload.code, "REQUEST_BODY_TOO_LARGE");
});
