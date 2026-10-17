# 遷移指南:從 LiteLLM / one-api 到 Akentros

Akentros 的設計目標之一就是承接 LiteLLM 與 one-api 的既有用戶——同樣是
「OpenAI 相容的閘道 + 多供應商 + 金鑰管理」,但把計費正確性、冪等與
fail-closed 安全邊界做為不可妥協的核心。本文映射兩邊的概念與步驟。

## 概念對照

| 概念 | LiteLLM | one-api | Akentros |
| --- | --- | --- | --- |
| 服務端點 | `OPENAI_API_BASE` / `api_base` | `--port` 上的 `/v1` | `/api/ai/v1`(任何 OpenAI SDK 指向即可) |
| 用戶端金鑰 | Virtual Keys | Tokens(令牌) | `sk-akentros-live_/test_` API 金鑰 |
| 上游憑證 | `litellm --api_key` / config YAML | Channels(渠道) | Provider Pool(環境變數名稱;secret 不落地) |
| 模型命名 | `openai/gpt-4o`、`anthropic/claude-…` | 渠道內模型映射 | `akentros/<model>`(定價權威見 `backend-pricing.v1.json`) |
| 預算控制 | Budgets(金額 / 時長) | Quota(額度) | 金鑰級美元消費上限 + 餘額(微美元整數結算) |
| 速率限制 | RPM / TPM 設定 | 依渠道 | 金鑰級 RPM + 最大併發(資料庫交易內原子計數) |
| 團隊 / 組織 | Teams、Orgs | Users、Groups | 單租格帳號系統(內建,無多租戶概念) |
| 管理介面 | Admin UI(較新版本) | Web 控制台 | 開發者控制台(React,可 `?demo=1` 離線體驗) |
| 部署形態 | Python(Docker/Beanstalk) | Go(Docker 為主) | Node ≥ 22.18 單程序 / Cloudflare Workers / **Docker(Topology D)** |

## 從 LiteLLM 遷移

**1. 端點與金鑰。** 客戶端只改兩個值:

```bash
# before (LiteLLM proxy)
export OPENAI_API_BASE="http://litellm:4000/v1"
export OPENAI_API_KEY="sk-litellm-virtual-key"

# after (Akentros gateway)
export OPENAI_API_BASE="https://gw.example.com/api/ai/v1"
export OPENAI_API_KEY="sk-akentros-live_…"
```

**2. 模型名稱。** LiteLLM 的 `provider/model` 命名改為 `akentros/model`。
上游選路是閘道的事(加權輪詢、健康冷卻、自動 failover),呼叫端不再指定
上游;需要固定上游時在 Provider Pool 的權重設定處理,而不是在模型名裡。

**3. 預算與限流。** LiteLLM 的 per-key budget 對應到 Akentros 的金鑰屬性:
`max_usd`(美元消費上限)、RPM、最大併發。差異:Akentros 的預算是**請求前
預留、完成後依實際 usage 結算**的硬上限(上游浮報 usage 也會被夾制在預留
額內),不是事後記帳。

**4. 冪等語義(最容易踩的差異)。** LiteLLM 的 cache 回應重放;Akentros 預設
對已完成的 `Idempotency-Key` 回 `409 idempotent_request_replayed`。依賴
「同鍵拿到同一回應」的程式,在金鑰上 opt-in `idempotency_replay_ttl_seconds`
(最長 7 天)即可得到 OpenAI 式重放。

**5. 不支援的端點。** 遷移前對照 README 的相容性矩陣:`images`、`audio`、
`moderations`、`files`、`batches`、legacy `completions`、`realtime` 會收到
`400 unsupported_feature`(帶明確錯誤碼)。LiteLLM 的 router fallback /
cooldown 语义由 Akentros 的 Provider Pool 內建(in-flight lease、健康冷卻、
自動 failover),不需要客戶端 retry 層的配合。

## 從 one-api 遷移

**1. 渠道 → Provider Pool。** one-api 每個渠道一組上游憑證;Akentros 的
`OPENROUTER_API_KEY_1` 式環境變數對應同樣的角色(37 個 credential 槽位),
但 secret 只存在 runtime 環境變數——資料庫僅存 opaque credential ID 與健康
狀態,備份資料庫不會帶走上游金鑰。渠道層的權重/優先級對應 pool 的加權輪詢。

**2. 令牌 → API 金鑰。** 概念一對一:`sk-akentros-*` 金鑰同樣有額度上限、
模型白名單、過期時間;差異是金鑰明文**只在建立/輪替時顯示一次**(落庫為
HMAC digest),且 RPM / 併發上限是閘道端原子強制,不是統計口徑。

**3. 額度 → 美元餘額。** one-api 的 quota 換算比率 getConfig 自定;Akentros
直接以美元計價、微美元整數結算,控制台與 `/v1` API 的用量數字單位一致,
不需要乘換算係數。

**4. 部署對等。** one-api 用戶的 Docker 直覺在 Topology D 完整保留:
`docker compose up` + volume 即得 gateway + console;SQLite 單檔備份
(停機複製)與 one-api 的經驗相同。多實例水平擴展目前**不支援**(計費與
限流依賴單一資料庫 + 程序內序列化)——需要水平擴展前請先確認單實例
(加 PG)的容量是否已到極限。

## 遷移後的驗證清單

1. `GET /healthz` 回 200(部署煙霧測試,見 `docs/DEPLOYMENT.md` §3)。
2. 未帶金鑰打 `POST /chat/completions` → `401`(證明推理面 + 閘道 + DB 讀取都在)。
3. `GET /models` 列出的模型與控制台目錄一致(契約測試在 CI 釘死這一點)。
4. 一筆帶 `Idempotency-Key` 的請求重送一次,確認 409(或 opt-in 後的重放
   標頭 `X-Akentros-Idempotent-Replay: true`)。
5. 控制台「用量」頁的微美元數字與你客戶端收到的 `usage` 對得上
   (prompt + completion token × 單價;embeddings 只計輸入)。
