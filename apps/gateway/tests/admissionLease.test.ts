import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { createApp } from "../src/app.ts";
import { createAkentrosApiKey } from "../src/utils/aiApiKeys.ts";
import { ensureAkentrosSchemaReady } from "../src/utils/bootstrap.ts";
import { dbQuery, installNodeAkentrosDbAdapter } from "../src/utils/db.ts";

// ECO-ADJ-1 回歸測試:驗證失敗(400)必須釋放 admission 租約。原實作
// 僅在 prepared?.requestId 存在時釋放,導致每個被拒的無效請求都洩漏一個
// in-flight 租約 —— max_in_flight 次(預設 4)無效請求後,金鑰被 429 鎖死
// 直到 5 分鐘租約 TTL。遷移者 SDK 常態攜帶被拒參數(logprobs、response_format
// 舊形狀等),此洩漏把「可分辨的 400」劣化成「鎖死 5 分鐘」。

await installNodeAkentrosDbAdapter();

const env: any = {
  AKENTROS_DB_PATH: ":memory:",
  AKENTROS_API_KEY_PEPPER: "pepper-".repeat(8),
  AKENTROS_ENABLED: "true",
  OPENAI_API_KEY_1: "test-openai-key",
};
await ensureAkentrosSchemaReady(env);

async function seedUser(email: string) {
  const inserted = await dbQuery(
    env,
    `
    INSERT INTO users (username, email, password_hash, balance_usd_micros)
    VALUES ('admission-tester', ?, 'x', 100000000)
    RETURNING id
  `,
    [email],
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

async function unreleasedLeaseCount() {
  const rows = await dbQuery(
    env,
    "SELECT COUNT(*) AS active FROM ai_api_inflight_leases WHERE released_at IS NULL",
  );
  return Number((rows.rows as any[])[0].active);
}

test("validation failures release the admission lease instead of leaking it", async (t) => {
  const userId = await seedUser("admission-leak@example.com");
  // max_in_flight=2:只要洩漏 2 個租約,後續請求就會被 429 鎖死。
  const { secret } = await createAkentrosApiKey(env, userId, {
    name: "leak-probe-key",
    max_in_flight: 2,
    rpm_limit: 100,
  });
  const app = createTestApp(env);
  const headers = { authorization: `Bearer ${secret}`, "content-type": "application/json" };

  await t.test("chat validation 400s release the provisional lease", async () => {
    const before = await unreleasedLeaseCount();
    // 連續 3 個(max_in_flight 之上)被拒的無效請求:若租約洩漏,
    // 第 3 個會是 429 而非 400。
    for (let index = 0; index < 3; index += 1) {
      const response = await app.request("/api/ai/v1/chat/completions", {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "akentros/gpt-5.2",
          messages: [{ role: "user", content: "hi" }],
          logprobs: true,
        }),
      });
      assert.equal(response.status, 400, "validation rejection must stay 400, not 429");
      assert.equal(((await response.json()) as any).error.code, "unsupported_parameter");
    }
    assert.equal(await unreleasedLeaseCount(), before);
  });

  await t.test("responses validation 400s release the provisional lease", async () => {
    const before = await unreleasedLeaseCount();
    for (let index = 0; index < 3; index += 1) {
      const response = await app.request("/api/ai/v1/responses", {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "akentros/gpt-5.2",
          input: "hi",
          background: true,
        }),
      });
      assert.equal(response.status, 400, "responses rejection must stay 400, not 429");
      assert.equal(((await response.json()) as any).error.code, "unsupported_feature");
    }
    assert.equal(await unreleasedLeaseCount(), before);
  });

  await t.test("embeddings validation 400s release the provisional lease", async () => {
    const before = await unreleasedLeaseCount();
    for (let index = 0; index < 3; index += 1) {
      const response = await app.request("/api/ai/v1/embeddings", {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "akentros/text-embedding-3-small",
          input: "hello",
          vendor_hint: "rejected",
        }),
      });
      assert.equal(response.status, 400, "embeddings rejection must stay 400, not 429");
      assert.equal(((await response.json()) as any).error.code, "unsupported_parameter");
    }
    assert.equal(await unreleasedLeaseCount(), before);
  });

  await t.test("a valid request still executes after the invalid burst", async () => {
    // 打完整流程(stub 的上游)證明金鑰沒有被無效請求鎖死。
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          id: "upstream-after-leak",
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as any;
    try {
      const response = await app.request("/api/ai/v1/chat/completions", {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "akentros/gpt-5.2",
          messages: [{ role: "user", content: "still admitted?" }],
        }),
      });
      assert.equal(response.status, 200);
      assert.equal(((await response.json()) as any).choices[0].message.content, "ok");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
