// 冪等重送:同一個 Idempotency-Key + 同一個請求體,第二次送達時 gateway
// 會告訴你「這個鍵已經完成」——這是 Akentros 與 OpenAI 的刻意語義差異:
//
//   預設      → 409 idempotent_request_replayed(附原始 X-Request-Id)
//   opt-in    → 金鑰上設定 idempotency_replay_ttl_seconds(最長 7 天)後,
//               同鍵同體的重送會直接重播原始回應
//               (X-Akentros-Idempotent-Replay: true),不重新執行、不重複計費
//
// 進行中的鍵重送 → 409 idempotent_request_in_progress
// 同鍵不同請求體 → 409 idempotent_request_conflict
import OpenAI from "openai";

const baseURL = process.env.AKENTROS_BASE_URL ?? "http://localhost:8787/api/ai/v1";
const apiKey = process.env.AKENTROS_API_KEY;
if (!apiKey) {
  console.error("請先設定 AKENTROS_API_KEY(在控制台「金鑰」頁建立)");
  process.exit(1);
}

const client = new OpenAI({ baseURL, apiKey });

const idempotencyKey = `demo-${Date.now()}`;
const request = {
  model: process.env.AKENTROS_MODEL ?? "akentros/gpt-5.2",
  messages: [{ role: "user", content: "回覆「好的」兩個字就好。" }],
};

// 第一次:正常執行
const first = await client.chat.completions.create(request, {
  headers: { "Idempotency-Key": idempotencyKey },
});
console.log("第一次回覆:", first.choices[0].message.content);

// 第二次:同鍵同體重送 → 409 idempotent_request_replayed(預設)或重播(opt-in)
try {
  await client.chat.completions.create(request, {
    headers: { "Idempotency-Key": idempotencyKey },
  });
  console.log("第二次:直接重播了原始回應(金鑰已 opt-in 重放 TTL)");
} catch (error) {
  const status = error.status ?? "n/a";
  const code = error.error?.code ?? error.message;
  console.log(`第二次:${status} ${code}(未 opt-in 時的預設行為,附原始 X-Request-Id)`);
}
