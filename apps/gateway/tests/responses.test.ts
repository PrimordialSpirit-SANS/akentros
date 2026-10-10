import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { createApp } from "../src/app.ts";
import { createAkentrosApiKey } from "../src/utils/aiApiKeys.ts";
import { ensureAkentrosSchemaReady } from "../src/utils/bootstrap.ts";
import { dbQuery, installNodeAkentrosDbAdapter } from "../src/utils/db.ts";

await installNodeAkentrosDbAdapter();

const env: any = {
  AKENTROS_DB_PATH: ":memory:",
  AKENTROS_API_KEY_PEPPER: "pepper-".repeat(8),
  AKENTROS_ENABLED: "true",
  OPENAI_API_KEY_1: "test-openai-key",
};
await ensureAkentrosSchemaReady(env);

async function seedUser(email: string, balanceMicros = 100_000_000) {
  const inserted = await dbQuery(
    env,
    `
    INSERT INTO users (username, email, password_hash, balance_usd_micros)
    VALUES ('responses-tester', ?, 'x', ?)
    RETURNING id
  `,
    [email, balanceMicros],
  );
  return String(inserted.rows[0].id);
}

function createTestApp(sharedEnv: any) {
  const outer = new Hono();
  outer.use("*", async (c: any, next: any) => {
    c.env = sharedEnv;
    await next();
  });
  outer.route("/", createApp(sharedEnv));
  return outer;
}

function sseFrames(body: string) {
  return body
    .split("\n\n")
    .map((frame) => frame.trim())
    .filter(Boolean);
}

// SSE 事件一律以空行結尾(含最後一頓);少了 trailing 空行的最終事件會被
// 解析器丢棄,導致 [DONE] 不可見、串流視為中斷。
function sseBody(events: string[]) {
  return `${events.map((event) => `data: ${event}`).join("\n\n")}\n\n`;
}

test("POST /api/ai/v1/responses bridges onto the chat pipeline end to end", async (t) => {
  const userId = await seedUser("responses-e2e@example.com");
  const { secret } = await createAkentrosApiKey(env, userId, { name: "responses-key" });

  const app = createTestApp(env);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    // 橋接執行走 chat/completions 上游(以 openai-production 池 stub)。
    assert.ok(String(url).endsWith("/chat/completions"), `unexpected upstream URL: ${url}`);
    const payload = JSON.parse(init.body);
    assert.equal(payload.model, "gpt-6-astra");
    // instructions → system、input → user 的轉換必須抵達上游。
    assert.deepEqual(payload.messages, [
      { role: "system", content: "Answer concisely." },
      { role: "user", content: "Hello responses bridge" },
    ]);
    return new Response(
      JSON.stringify({
        id: "upstream-responses",
        object: "chat.completion",
        choices: [
          { index: 0, message: { role: "assistant", content: "Bridged hello" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 9, completion_tokens: 5, total_tokens: 14 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as any;

  await t.test("non-streaming responses are wrapped into a Responses object", async () => {
    try {
      const response = await app.request("/api/ai/v1/responses", {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: "akentros/gpt-6-astra",
          instructions: "Answer concisely.",
          input: "Hello responses bridge",
          max_output_tokens: 128,
        }),
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as any;
      assert.equal(body.object, "response");
      assert.match(body.id, /^resp_/);
      assert.equal(body.status, "completed");
      assert.equal(body.incomplete_details, null);
      assert.equal(body.instructions, "Answer concisely.");
      assert.equal(body.max_output_tokens, 128);
      assert.equal(body.output.length, 1);
      assert.equal(body.output[0].type, "message");
      assert.equal(body.output[0].content[0].type, "output_text");
      assert.equal(body.output[0].content[0].text, "Bridged hello");
      assert.deepEqual(body.usage, { input_tokens: 9, output_tokens: 5, total_tokens: 14 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await t.test("streaming responses emit the bridged response.* event sequence", async () => {
    globalThis.fetch = (async () =>
      new Response(
        sseBody([
          '{"choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"},"finish_reason":null}]}',
          '{"choices":[{"index":0,"delta":{"content":" there"},"finish_reason":null}]}',
          '{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}',
          "[DONE]",
        ]),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      )) as any;
    try {
      const response = await app.request("/api/ai/v1/responses", {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: "akentros/gpt-6-astra",
          input: "Hello streaming bridge",
          stream: true,
        }),
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") || "", /text\/event-stream/);
      const body = await response.text();
      const events = sseFrames(body).map((frame) => {
        const eventLine = frame.split("\n")[0];
        return eventLine.replace(/^event:\s*/, "");
      });
      assert.deepEqual(events, [
        "response.created",
        "response.output_item.added",
        "response.content_part.added",
        "response.output_text.delta",
        "response.output_text.delta",
        "response.output_text.done",
        "response.content_part.done",
        "response.output_item.done",
        "response.completed",
      ]);
      const completed = JSON.parse(
        sseFrames(body)
          .find((frame) => frame.startsWith("event: response.completed"))
          ?.split("\n")[1]
          ?.replace(/^data:\s*/, "") || "{}",
      );
      assert.equal(completed.response.status, "completed");
      assert.equal(completed.response.output[0].content[0].text, "Hi there");
      assert.deepEqual(completed.response.usage, { input_tokens: 4, output_tokens: 2, total_tokens: 6 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await t.test("advanced responses features are rejected with unsupported_feature", async () => {
    for (const extra of [
      { background: true },
      { previous_response_id: "resp_1" },
      { tools: [] },
      { reasoning: {} },
    ]) {
      const response = await app.request("/api/ai/v1/responses", {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "akentros/gpt-6-astra", input: "hi", ...extra }),
      });
      assert.equal(response.status, 400);
      const body = (await response.json()) as any;
      assert.equal(body.error.code, "unsupported_feature");
    }
  });

  await t.test("billing rows record the responses endpoint label", async () => {
    const rows = await dbQuery(
      env,
      `
      SELECT endpoint, status FROM ai_requests
      WHERE endpoint = 'responses' AND status = 'succeeded'
      ORDER BY id DESC
    `,
    );
    // 前兩個子測試(非串流 + 串流)都應落地 endpoint='responses' 的成功紀錄。
    assert.ok((rows.rows as any[]).length >= 2);
  });
});

test("legacy chat keys without the responses scope stay backward compatible", async (t) => {
  const userId = await seedUser("responses-legacy@example.com");
  // 僅有 chat:completions 的既有金鑰(模擬 responses 上線前建立):
  // 建立後直接改寫 scopes 欄位。
  const created = await createAkentrosApiKey(env, userId, { name: "legacy-chat-key" });
  await dbQuery(env, `UPDATE ai_api_keys SET scopes = ? WHERE id = ?`, [
    JSON.stringify(["chat:completions", "models:read"]),
    created.id,
  ]);
  const secret = created.secret;
  const app = createTestApp(env);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        id: "upstream-legacy",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as any;
  try {
    const response = await app.request("/api/ai/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "akentros/gpt-5.2", input: "legacy key" }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as any;
    assert.equal(body.object, "response");
    assert.equal(body.output[0].content[0].text, "ok");

    // 無關 scope 的金鑰完全不能存取 /responses(403 insufficient_scope)。
    const otherUser = await seedUser("responses-noscope@example.com");
    const embedOnlyKey = await createAkentrosApiKey(env, otherUser, { name: "embed-only-key" });
    await dbQuery(env, `UPDATE ai_api_keys SET scopes = ? WHERE id = ?`, [
      JSON.stringify(["embeddings", "models:read"]),
      embedOnlyKey.id,
    ]);
    const denied = await app.request("/api/ai/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${embedOnlyKey.secret}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "akentros/gpt-5.2", input: "no" }),
    });
    assert.equal(denied.status, 403);
    assert.equal(((await denied.json()) as any).error.code, "insufficient_scope");
  } finally {
    globalThis.fetch = originalFetch;
  }
  await t.test("default scopes now include responses", async () => {
    const { AKENTROS_DEFAULT_SCOPES } = await import("@akentros/core/apiKeys");
    assert.deepEqual(
      [...AKENTROS_DEFAULT_SCOPES],
      ["chat:completions", "embeddings", "responses", "models:read"],
    );
  });
});
