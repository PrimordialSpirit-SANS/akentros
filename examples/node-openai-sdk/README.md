# Node + OpenAI SDK

官方 `openai` 套件指向 gateway 的 `baseURL` 即可,無需任何 fork 或轉接層。

```bash
npm install
export AKENTROS_API_KEY=sk-akentros-live_...        # 控制台建立
export AKENTROS_BASE_URL=http://localhost:8787/api/ai/v1
npm run chat          # 基本 chat/completions
npm run stream        # SSE 串流(含終止 chunk 的 usage)
npm run idempotency   # Idempotency-Key 冪等重送與 409 語義
```

## 檔案

| 檔案 | 展示 |
| --- | --- |
| `chat.mjs` | 最小接入:`new OpenAI({ baseURL, apiKey })` |
| `stream.mjs` | 串流 + `stream_options.include_usage`(計費依據) |
| `idempotency.mjs` | 冪等鍵的三種 409 語義與 opt-in 重放 |

## 常見調整

- **模型清單**:`await client.models.list()` 或 `curl …/models`。
- **改走 `responses` API**:`client.responses.create({ model, input })`(橋接子集,進階欄位回 `400 unsupported_feature`)。
- **逾時與重試**:SDK 層的 `timeout`/`maxRetries` 照常作用;閘道端的 `Idempotency-Key` 才是跨重試的執行去重,兩者建議搭配使用。
