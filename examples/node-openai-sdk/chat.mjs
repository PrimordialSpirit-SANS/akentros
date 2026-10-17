// 最小接入:官方 OpenAI SDK 指向 Akentros 的 baseURL 即可。
// 環境變數:AKENTROS_BASE_URL(預設 http://localhost:8787/api/ai/v1)、AKENTROS_API_KEY。
import OpenAI from "openai";

const baseURL = process.env.AKENTROS_BASE_URL ?? "http://localhost:8787/api/ai/v1";
const apiKey = process.env.AKENTROS_API_KEY;
if (!apiKey) {
  console.error("請先設定 AKENTROS_API_KEY(在控制台「金鑰」頁建立)");
  process.exit(1);
}

const client = new OpenAI({ baseURL, apiKey });

const completion = await client.chat.completions.create({
  model: process.env.AKENTROS_MODEL ?? "akentros/gpt-5.2",
  messages: [{ role: "user", content: "用一句話介紹你自己。" }],
});

const choice = completion.choices[0];
console.log("回覆:", choice.message.content);
console.log("用量:", JSON.stringify(completion.usage));
// usage 是計費依據(預留→依實際 usage 結算→差額退回),金額會反應在控制台「用量」頁
