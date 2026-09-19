import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { createApp } from "../src/app.ts";
import { createAkentrosApiKey } from "../src/utils/aiApiKeys.ts";
import {
  cleanupAkentrosIdempotentReplays,
  readAkentrosIdempotentReplay,
  saveAkentrosIdempotentReplay,
} from "../src/utils/aiIdempotency.ts";
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

async function seedUser(email: string) {
  const inserted = await dbQuery(
    env,
    `
    INSERT INTO users (username, email, password_hash, balance_usd_micros)
    VALUES ('replay-tester', ?, 'x', 100000000)
    RETURNING id
  `,
    [email],
  );
  return String(inserted.rows[0].id);
}

// gatewaySurface 同款測試殼:handlers 讀 c.env,以 middleware 注入共享 env。
function createTestApp(sharedEnv: any) {
  const outer = new Hono();
  outer.use("*", async (c: any, next: any) => {
    c.env = sharedEnv;
    await next();
  });
  outer.route("/", createApp(sharedEnv));
  return outer;
}

function fingerprint(value: string) {
  return value.padEnd(64, "0").slice(0, 64);
}

test("replay store round-trips, expires, refuses mismatched fingerprints, and ignores duplicates", async () => {
  const fingerprintValue = fingerprint("a");
  const saved = await saveAkentrosIdempotentReplay(env, {
    requestId: "req_replay_store_1",
    apiKeyId: 1,
    idempotencyKey: "idem-a",
    requestFingerprint: fingerprintValue,
    endpoint: "chat.completions",
    contentType: "application/json",
    payload: JSON.stringify({ ok: 1 }),
    ttlSeconds: 3600,
  });
  assert.equal(saved, true);

  const hit = await readAkentrosIdempotentReplay(env, {
    apiKeyId: 1,
    idempotencyKey: "idem-a",
    requestFingerprint: fingerprintValue,
  });
  assert.equal(hit?.status, 200);
  assert.equal(hit?.contentType, "application/json");
  assert.deepEqual(JSON.parse(hit?.payload || "{}"), { ok: 1 });

  // 指紋不一致 = 同一冪等鍵綁不同請求體 → 與 billing.reserve 相同的 409。
  await assert.rejects(
    readAkentrosIdempotentReplay(env, {
      apiKeyId: 1,
      idempotencyKey: "idem-a",
      requestFingerprint: fingerprint("b"),
    }),
    (error: any) => error.status === 409 && error.code === "idempotency_conflict",
  );

  // 同 (api_key_id, idempotency_key) 的第二次落地必須被唯一索引擋下。
  const duplicate = await saveAkentrosIdempotentReplay(env, {
    requestId: "req_replay_store_2",
    apiKeyId: 1,
    idempotencyKey: "idem-a",
    requestFingerprint: fingerprintValue,
    endpoint: "chat.completions",
    contentType: "application/json",
    payload: JSON.stringify({ ok: 2 }),
    ttlSeconds: 3600,
  });
  assert.equal(duplicate, false);

  // 過期列讀取視同未命中,並由維護清理移除。
  await dbQuery(
    env,
    `
    INSERT INTO ai_idempotency_replays (
      request_id, api_key_id, idempotency_key, request_fingerprint,
      endpoint, response_status, content_type, response_payload, payload_bytes, expires_at
    )
    VALUES ('req_replay_store_3', 1, 'idem-b', ?, 'chat.completions', 200,
            'application/json', '{}', 2, '2020-01-01T00:00:00.000Z')
  `,
    [fingerprint("c")],
  );
  const expired = await readAkentrosIdempotentReplay(env, {
    apiKeyId: 1,
    idempotencyKey: "idem-b",
    requestFingerprint: fingerprint("c"),
  });
  assert.equal(expired, null);
  const removed = await cleanupAkentrosIdempotentReplays(env);
  assert.equal(removed, 1);

  // TTL 關閉(0)不落地。
  const disabled = await saveAkentrosIdempotentReplay(env, {
    requestId: "req_replay_store_4",
    apiKeyId: 1,
    idempotencyKey: "idem-c",
    requestFingerprint: fingerprintValue,
    endpoint: "chat.completions",
    contentType: "application/json",
    payload: "{}",
    ttlSeconds: 0,
  });
  assert.equal(disabled, false);
});

test("opt-in key replays the stored response; non-opt-in key keeps 409 semantics", async () => {
  const userId = await seedUser("replay-e2e@example.com");
  const { secret } = await createAkentrosApiKey(env, userId, {
    name: "replay-key",
    idempotency_replay_ttl_seconds: 3600,
  });
  const { secret: plainSecret } = await createAkentrosApiKey(env, userId, {
    name: "no-replay-key",
  });

  const app = createTestApp(env);
  const requestBody = {
    model: "akentros/gpt-5.2",
    messages: [{ role: "user", content: "Hello replay" }],
  };
  let providerCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    providerCalls += 1;
    assert.ok(String(url).endsWith("/chat/completions"), `unexpected upstream URL: ${url}`);
    assert.equal(JSON.parse(init.body).model, "gpt-5.2");
    return new Response(
      JSON.stringify({
        id: "upstream-e2e",
        object: "chat.completion",
        choices: [
          { index: 0, message: { role: "assistant", content: "replayed answer" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as any;

  try {
    // 第一次執行:真實呼叫 provider(被 stub)一次。
    const first = await app.request("/api/ai/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
        "idempotency-key": "e2e-1",
      },
      body: JSON.stringify(requestBody),
    });
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(providerCalls, 1);

    // 完成鍵重送(同鍵同體):重放原始回應,不再執行推論。
    const second = await app.request("/api/ai/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
        "idempotency-key": "e2e-1",
      },
      body: JSON.stringify(requestBody),
    });
    assert.equal(second.status, 200);
    assert.equal(second.headers.get("x-akentros-idempotent-replay"), "true");
    assert.deepEqual(await second.json(), firstBody);
    assert.equal(providerCalls, 1);

    // 重放必須在請求紀錄留下一列 status='replayed' 的輕量紀錄,指向被重放的
    // 原始請求,且計費欄位全 0、idempotency_key 為 NULL(避開部分唯一索引)。
    const replayRow = await dbQuery(
      env,
      `
      SELECT r.request_id, r.replay_of_request_id, r.status, r.charged_usd_micros,
             r.reserved_usd_micros, r.idempotency_key
      FROM ai_requests AS r
      JOIN ai_requests AS original ON original.request_id = r.replay_of_request_id
      WHERE r.status = 'replayed'
        AND original.idempotency_key = 'e2e-1'
      LIMIT 1
    `,
    );
    const row: any = replayRow.rows[0];
    assert.ok(row, "a replayed request log row must exist");
    assert.equal(Number(row.charged_usd_micros), 0);
    assert.equal(Number(row.reserved_usd_micros), 0);
    assert.equal(row.idempotency_key, null);

    // 同鍵不同體:409 idempotency_conflict(與 OpenAI 的 422 語意對應)。
    const conflict = await app.request("/api/ai/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
        "idempotency-key": "e2e-1",
      },
      body: JSON.stringify({
        model: "akentros/gpt-5.2",
        messages: [{ role: "user", content: "Different body" }],
      }),
    });
    assert.equal(conflict.status, 409);
    const conflictBody: any = await conflict.json();
    assert.equal(conflictBody.error.code, "idempotency_conflict");
    assert.equal(providerCalls, 1);

    // 未 opt-in 的金鑰:第一次正常執行,完成鍵重送維持 409 不重放。
    const plainFirst = await app.request("/api/ai/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${plainSecret}`,
        "content-type": "application/json",
        "idempotency-key": "e2e-2",
      },
      body: JSON.stringify(requestBody),
    });
    assert.equal(plainFirst.status, 200);
    await plainFirst.json();
    assert.equal(providerCalls, 2);

    const plainSecond = await app.request("/api/ai/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${plainSecret}`,
        "content-type": "application/json",
        "idempotency-key": "e2e-2",
      },
      body: JSON.stringify(requestBody),
    });
    assert.equal(plainSecond.status, 409);
    const plainSecondBody: any = await plainSecond.json();
    assert.equal(plainSecondBody.error.code, "idempotent_request_replayed");
    assert.equal(providerCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
