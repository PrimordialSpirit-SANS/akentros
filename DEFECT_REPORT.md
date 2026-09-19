# Akentros Gateway 缺陷檢查報告

- **日期**：2026-09-18
- **範圍**：整個 monorepo（`packages/core`、`apps/gateway`、`apps/console`），含未提交的工作區變更
- **方法**：靜態程式碼审查（金額路徑、認證、限流、DB 層、SSE 解析、前端生命週期逐一閱讀）＋ 既有測試套件執行 ＋ 對可疑缺陷撰寫臨時重現測試（驗證後已刪除）
- **自動化驗證結果**：`npm run typecheck` ✅、`npm test`（console 63 + gateway 25 + core 全數通過）✅、`biome check .` ✅

---

## 總評

整體工程品質高：SQL 全面參數化（並有測試釘死此不變量）、微美元整數計費、狀態機式預留/結算/退款、許多歷史修復都以註解記錄成因。本次檢查發現 **1 個已重現驗證的高風險計費完整性缺陷、2 個中風險問題、5 個低風險問題**。

| # | 嚴重度 | 摘要 | 位置 |
|---|--------|------|------|
| 1 | 高 | 結算無 `LEAST` 上限夾制，上游浮報 usage 可超額扣款（已重現） | `packages/core/src/billing.ts` settle |
| 2 | 中 | Node 部署的登入限流可偽造 `cf-connecting-ip` 標頭繞過 | `apps/gateway/src/routes/auth.ts:113` |
| 3 | 中 | Node SQLite adapter 交易未序列化，潛在併發斷崖 | `apps/gateway/src/utils/db.node.ts:138-163` |
| 4 | 低 | 每個請求重建整個 Hono app（效能浪費） | `apps/gateway/src/nodeServer.ts:34` |
| 5 | 低 | 註冊並發 race：重複信箱回 500 而非 409 | `apps/gateway/src/routes/auth.ts:208-219` |
| 6 | 低 | Anthropic 不支援 `tool_choice: "none"` | `packages/core/src/providers.ts:310-320` |
| 7 | 低 | 關機流程可能被未斷開的 SSE 串流掛住 | `apps/gateway/src/nodeServer.ts:54-58` |
| 8 | 低 | 冪等重放回 409 而非重播回應（與 OpenAI 語意不同） | `packages/core/src/inference.ts` `replayError` |

---

## 高風險

### 1. 結算無上限夾制 —— 上游浮報 usage 可超額扣款（已重現驗證）

**位置**：`packages/core/src/billing.ts`（`settle` 的 SQL，約 544–557 行）

**問題**：`packages/core/src/inference.ts`（約 617–620 行）的註解明確宣稱不變量：

> 「settle 的 SQL 以 LEAST(actual, reserved) 夾制，估計永不超過原保留額，維持絕不多收立場」

但 `settle` 的 SQL 實際上是：

```sql
SET charged_usd_micros = ?,
    refunded_usd_micros = CAST(reserved_usd_micros - ? AS INTEGER),
```

**沒有任何 `LEAST` 夾制**；全 repo 也搜不到。`charged_usd_micros` 直接採信上游回報的實際成本。既有測試只覆蓋「實際 < 預留」（8 預留、3 結算、5 退款），從未測「實際 > 預留」。

**重現結果**（臨時測試，驗證後已刪除）：

- 預留 1000 µUSD、以 `actualCostMicros = 9000` 結算 →
  - `charged_usd_micros = 9000`（超出預留授權上限 9 倍）
  - `refunded_usd_micros = -8000`（**負數退款**，會寫入 DB 與對帳報表）
  - 用戶餘額 1,000,000 → 999,000（被扣 9000，而非上限 1000；餘額可被扣至負數）

**觸發條件**：正常路徑下輸入 token 估計（整個請求 JSON 的位元組數 + 開銷）非常保守，幾乎不可能低估；現實觸發要件是**上游供應商回報浮報的 usage**（惡意或有 bug 的 aggregator）。預留單的整個意義就是「事先授權的消費上限」，SQL 層未強制夾制，等於把「絕不多收」的防線交給上游自律——這正是 `inference.ts` 註解宣稱要防禦的場景。

**建議修復**（改動最小）：

```sql
SET charged_usd_micros = LEAST(?, reserved_usd_micros),
    refunded_usd_micros = CAST(reserved_usd_micros - LEAST(?, reserved_usd_micros) AS INTEGER),
```

並補一筆「`actual > reserved` 時 `charged == reserved`」的測試釘死此不變量。

---

## 中風險

### 2. Node 自架部署的登入限流可用偽造標頭繞過

**位置**：`apps/gateway/src/routes/auth.ts:113`

```ts
keyGenerator: (c) => String(c.req.header("cf-connecting-ip") || "local"),
```

**問題**：auth 限流（登入/註冊/登出，60 次 / 15 分鐘）以 `cf-connecting-ip` **請求標頭**作為身份。此標頭只有在 Cloudflare 代理後方是可信的；但 README 的主要部署模式是 **Node 自架**（`npm run dev:gateway` / `start:gateway`），Node/http 不會過濾這個標頭——攻擊者每個請求帶一個不同的假 IP，限流即完全失效，可無限暴力嘗試密碼與洗註冊（註冊還附送點數）。

**建議修復**：Node 進入點改用 socket remote address 作為限流身份；或僅在明確設定「信任反向代理」時才讀取該標頭，否則回退到 remote address。

### 3. Node SQLite adapter 的交易未序列化（潛在斷崖）

**位置**：`apps/gateway/src/utils/db.node.ts:138-163`（對照 `apps/gateway/src/worker/doDb.ts:92-112`）

**問題**：`withAkentrosTransaction` 在已有交易開啟時**不排隊**，直接執行 `BEGIN IMMEDIATE`。若兩筆交易真的重疊，第二筆會拋 SQLite「cannot start a transaction within a transaction」，對外變成 503。目前沒爆炸，只是因為所有交易體內恰好只有同步 DB 呼叫（純 microtask 鏈不會與其他請求的 macrotask 交錯）——這是一個**未被文件化、也未被程式碼強制的脆弱不變量**。對照組 DO adapter（`doDb.ts`）明確用 `txChain` promise chain 序列化交易，可見作者自己也認為需要這層防禦；`dbQuery` 的非交易路徑也有佇列，唯獨交易本身沒有。

**風險**：未來任何人在任一交易 fn 內加一個真 I/O 的 `await`（例如呼叫外部服務、WebCrypto threadpool），此問題就會在併發負載下以隨機 503 的形式浮現，且極難回溯。

**建議修復**：比照 `doDb.ts`，在 `db.node.ts` 加上以 database 檔案為鍵的交易序列化 chain。

---

## 低風險

### 4. 每個請求重建整個 Hono app

**位置**：`apps/gateway/src/nodeServer.ts:34`

```ts
fetch: (request) => createApp(env).fetch(request, env as any),
```

每個請求都重新建構 Hono 實例、重新註冊所有路由與中介層（所幸兩個 limiter 是模組級共享，狀態不受影響）。功能正確但每請求多餘的配置與 GC 壓力。`createApp(env)` 提到 `serve()` 之外建一次即可。

### 5. 註冊並發 race

**位置**：`apps/gateway/src/routes/auth.ts:208-219`

先 `findUserByEmail` 再 `createUser`；兩個併發的同信箱註冊都通過檢查後，第二個 INSERT 撞 UNIQUE 約束，經 `onError` 回 500 而非語意正確的 409 `email_taken`。影響輕微（資料不會損毀），建議捕捉約束違反轉 409。

### 6. Anthropic 不支援 `tool_choice: "none"`

**位置**：`packages/core/src/providers.ts:310-320`（`anthropicRequestBody`）

`tool_choice: "none"` 被映射為 `undefined`，Anthropic 端退回預設 `auto`——用戶明確要求「本次不呼叫工具」時，上游仍可能呼叫工具。其餘映射（`required` → `any`、指定函式 → `tool`）正確。

### 7. 關機流程可能掛住

**位置**：`apps/gateway/src/nodeServer.ts:54-58`

`shutdown()` 等待 `server.close()` 回呼，但 Node 的 `http.Server.close()` 要等所有連線結束；未斷開的 SSE 串流（長時間推論）會讓回呼永遠不觸發，`process.exit(0)` 無法抵達。建議對串流連線追蹤並主動關閉，或設置關機逾時。

### 8. 冪等重放回 409 而非重播回應（設計選擇，需知情）

**位置**：`packages/core/src/inference.ts`（`replayError`）

OpenAI 的 Idempotency-Key 語意是「重放回傳原始回應」；Akentros 對已完成的冪等鍵回 409 `idempotent_request_replayed`。此行為有專屬錯誤碼、屬刻意設計，但 README 標榜「任何 OpenAI SDK 指向 baseURL 即可使用」——重度依賴冪等重放的客戶端會觀察到行為差異。建議至少在 docs/openapi.yaml 與文件頁明確標註。

---

## 檢查過且確認乾淨的部分

| 領域 | 結論 |
|------|------|
| API 金鑰儲存 | HMAC + pepper digest 落庫、只在建立時顯示一次明文、損毀 allowlist fail-closed、ISO 格式到期比較（先前 bug 已修） |
| JWT 會話 | `crypto.subtle.verify` constant-time 驗證、`exp`/`sub` 格式檢查、金鑰長度不足時 fail-closed |
| 密碼 | PBKDF2-SHA256 600k 迭代（OWASP 建議值）、timing-safe 比較、dummy-hash 防登入帳號枚舉 |
| CSRF | 雙提交 cookie + `SameSite=Lax` + httpOnly 會話 cookie；比較用 timing-safe |
| SQL 安全 | 全面參數化；`billing.test.ts` 甚至以正則釘死 SQL 不含字串插值 |
| 計費狀態機 | reserve→settle→refund 冪等可重跑；（api_key_id, idempotency_key) partial unique index 支撐併發冪等；ledger 有防雙重入帳索引 |
| SSE 解析（伺服器與客戶端各一份） | CRLF/跨 chunk 緩衝、事件大小上限、EOF 丟棄未終結事件（防截斷的 `data: [DONE]` 假成功） |
| 串流生命週期 | `terminalPromise` 冪等收尾、cancel/abort 清理、admission lease 必釋放、客戶端中斷已收到 usage 時依實際用量結算 |
| 限流記憶體降級 | 桶滿只淘汰過期桶、不整表清除（防攻擊者歸零既有計數） |
| 前端 | 無 `dangerouslySetInnerHTML`/`innerHTML`、無 secret 寫入 localStorage、AbortController 生命週期與過期 controller 檢查正確 |
| DB 設定 | WAL + busy_timeout、相對路徑錨定 gateway 套件目錄（防 cwd 漂移）、foreign_keys 開啟 |

---

## 建議優先順序

1. **立即**：修 #1（兩行 SQL + 一筆測試）——金流完整性。
2. **短期**：修 #2（Node 部署的暴力防線）與 #3（比照 DO adapter 序列化，防未來隨機 503）。
3. **順手**：#4–#7 為小改動；#8 補文件即可。
