// SSE 串流:SDK 的 stream API 直接可用;串流結束的 usage 只在最後一個
// 带 `stream_options.include_usage` 的 chunk 出現(與 OpenAI 一致)。
import OpenAI from "openai";

const baseURL = process.env.AKENTROS_BASE_URL ?? "http://localhost:8787/api/ai/v1";
const apiKey = process.env.AKENTROS_API_KEY;
if (!apiKey) {
  console.error("請先設定 AKENTROS_API_KEY(在控制台「金鑰」頁建立)");
  process.exit(1);
}

const client = new OpenAI({ baseURL, apiKey });

const stream = await client.chat.completions.create({
  model: process.env.AKENTROS_MODEL ?? "akentros/gpt-5.2",
  messages: [{ role: "user", content: "從 1 數到 10,每個數字一行。" }],
  stream: true,
  stream_options: { include_usage: true },
});

for await (const chunk of stream) {
  const delta = chunk.choices[0]?.delta?.content;
  if (delta) process.stdout.write(delta);
  if (chunk.usage) {
    // 串流的 usage 在終止 chunk 上;計費以此為準
    console.error("\n用量:", JSON.stringify(chunk.usage));
  }
}
