# 框架與工具整合指南

Akentros 對外暴露 OpenAI 相容 API,所以「對接」的原則只有一條:**凡是能設定
OpenAI baseURL 的工具,就能指向 Akentros**。本文列出已驗證的主流對接方式
與各自的注意事項;通用契約如下:

| 項目 | 值 |
| --- | --- |
| Base URL | `https://<你的網域>/api/ai/v1`(本地開發 `http://localhost:8787/api/ai/v1`) |
| API Key | `sk-akentros-live_*` / `sk-akentros-test_*`(控制台建立,只顯示一次) |
| 模型名稱 | `akentros/<model>`(如 `akentros/gpt-5.2`;清單見 `GET /models`) |
| 串流 | OpenAI SSE 形態,`data: [DONE]` 終止 |
| 冪等 | `Idempotency-Key` 標頭;語義見下文與 `docs/openapi.yaml` |

可執行的最小範例在 [`examples/`](../examples/)(Node SDK、Python SDK、cURL)。

## LangChain(JavaScript / TypeScript)

`@langchain/openai` 的 `ChatOpenAI` 支援 `configuration.baseURL`,指向閘道即可:

```ts
import { ChatOpenAI } from "@langchain/openai";

const model = new ChatOpenAI({
  model: "akentros/gpt-5.2",
  apiKey: process.env.AKENTROS_API_KEY,
  configuration: {
    baseURL: "https://gw.example.com/api/ai/v1",
    defaultHeaders: {
      // LangChain 的鏈常有自動重試;冪等鍵讓重試不會重複執行/重複計費
      "Idempotency-Key": crypto.randomUUID(),
    },
  },
});

const stream = await model.stream("用一句話介紹你自己。");
for await (const chunk of stream) console.log(chunk.content);
```

注意:

- **結構化輸出**:`withStructuredOutput` 依賴 `response_format` 的 `json_schema`
  ——支援與否取決於模型的能力旗標(`structured_outputs`),不支援的模型會回
  可分辨的 `400`,換模型即可。
- **工具呼叫**:透傳給上游;Anthropic 類上游的 `tool_choice: "none"` 已知
  映射限制見 `docs/PROVIDERS.md`。

## LangChain(Python)

```python
from langchain_openai import ChatOpenAI

model = ChatOpenAI(
    model="akentros/gpt-5.2",
    api_key=os.environ["AKENTROS_API_KEY"],
    base_url="https://gw.example.com/api/ai/v1",
)
```

`stream()`、`bind_tools()` 等照常;Python SDK 的逾時與重試在 client 層,
冪等去重仍建議帶 `default_headers={"Idempotency-Key": …}`。

## Vercel AI SDK

`ai` 套件的 `createOpenAI` provider 直接吃 `baseURL`:

```ts
import { createOpenAI } from "@ai-sdk/openai";
import { streamText } from "ai";

const akentros = createOpenAI({
  baseURL: "https://gw.example.com/api/ai/v1",
  apiKey: process.env.AKENTROS_API_KEY,
});

const result = streamText({
  model: akentros("akentros/gpt-5.2"),
  prompt: "從 1 數到 10,每個數字一行。",
});

for await (const chunk of result.textStream) console.log(chunk);
```

注意:

- AI SDK 會自動帶 `stream_options.include_usage`——usage 統計照常運作。
- `generateObject` / ToolCallingAgent 同樣依賴模型能力旗標,行為同上節。

## OpenWebUI

設定路徑:**Settings → Connections → OpenAI API**:

| 欄位 | 值 |
| --- | --- |
| URL | `https://gw.example.com/api/ai/v1` |
| Key | `sk-akentros-live_…` |

之後在 **Admin Settings → Models** 按同步,`akentros/*` 模型會出現在選單。
建議為 OpenWebUI 單獨建一把金鑰,並在控制台設定 RPM / 併發上限——Web UI 的
併發行為不 受你控制,金鑰級上限是閘道端強制的硬限制。

## LobeChat

設定路徑:**Settings → Language Model → OpenAI**:

| 欄位 | 值 |
| --- | --- |
| API Proxy Endpoint | `https://gw.example.com/api/ai/v1` |
| API Key | `sk-akentros-live_…` |
| Client Fetch Mode | 視部署拓撲;伺服器端轉發即可關閉 |

再到模型清單手動加入 `akentros/<model>`。LobeChat 的伺服器端部署
(Docker)與 Akentros 的 Topology D 天然互補:同一台機器、兩個容器,
console/nginx 與 LobeChat 各自持有獨立金鑰,用量與限流完全分帳。

## cURL / 任何 HTTP 客戶端

見 [`examples/curl/`](../examples/curl/)——`Authorization: Bearer`、
`Content-Type: application/json`、串流加 `Accept: text/event-stream`,
就這三件事。錯誤回應是 OpenAI 形態的 JSON,錯誤碼可程式化判別
(`unsupported_feature`、`unsupported_parameter`、`rate_limit_exceeded`、
`insufficient_credits` 等,全清單見 `docs/openapi.yaml`)。

## 跨框架的三個語義差異(必讀)

1. **冪等重放**:OpenAI 對已完成的冪等鍵會重播原始回應;Akentros **預設**
   回 `409 idempotent_request_replayed`(附原始 `X-Request-Id`)。重度依賴
   重放語義的框架,請在金鑰上 opt-in `idempotency_replay_ttl_seconds`
   (最長 7 天)——成功回應落地該時限,同鍵同體重送直接重播,不再執行、
   不再計費。
2. **端點覆蓋**:`chat/completions`、`embeddings`、`responses`(橋接子集)、
   `models` 之外不支援(`images`、`audio`、`moderations`、`files`、`batches`、
   legacy `completions`、`realtime`)。依賴這些端點的整合會收到可分辨的
   `400`,不會沉默失敗。
3. **`n > 1`**:回 `400 unsupported_feature` 並提示改送獨立請求——平行取樣
   請用多個獨立請求(各自帶冪等鍵),而不是 OpenAI 的 `n` 參數。
