# ADR-0001:Akentros 重建邊界

> **狀態:部分已被取代(2026-09)。** 資料庫已由 PostgreSQL 遷移至 SQLite
> (,見 CHANGELOG)。本 ADR 的邊界決策(契約權威、設定分離、
> 安全與計費不變式)仍然有效;其中涉及 PostgreSQL 併發原語
> (FOR UPDATE / SKIP LOCKED / 資料修改 CTE)的描述以 SQLite 交易語義為準。

- 狀態:接受
- 日期:2026-07-11(2026-09-13 隨獨立開源版調整路徑與帳號系統描述)

## 背景

本專案的 Akentros 子系統採乾淨重建:以可驗證的 API、資料、計費與 runtime 契約為基線,不繼承任何未經驗證的舊 AI 殘餘(未載入的價格 JSON、來源不明的圖示等)。

Akentros 由單一 Worker/Hono 後端提供行為,並以 Akentros points 計費。外部 provider 呼叫、點數帳本與多 instance credential 選擇也都要求可稽核、可恢復且不洩漏秘密。

## 決策

### 1. 乾淨重建,單一權威

- 不繼承任何未在契約測試覆蓋範圍內的舊 AI 行為、schema 或價格。
- 對外契約以本 ADR 與 `docs/openapi.yaml` 為準;任何實作差異必須先更新契約並完成 review。

### 2. 對外 API 與 runtime 邊界固定

- 第一版公開推理面只提供 `GET /api/ai/v1/models` 與 `POST /api/ai/v1/chat/completions`,支援非串流及 SSE。
- 管理面只使用內建帳號系統的登入 cookie(akentros_token)、CSRF 與即時帳戶狀態檢查;推理面只接受 `sk-akentros-*` Key,兩者不可互換。
- 可攜核心放在 `packages/core`,只依賴 Web API;gateway(`apps/gateway`)僅負責 request、response、execution context 與資料庫 adapter。
- 公開 API 契約見 `docs/openapi.yaml`。

### 3. 設定權威分離

- `packages/core/config/backend-pricing.v1.json` 是啟用模型、固定公開價格、等價 provider route 與扣點的唯一 runtime 權威。
- `apps/console/public/data/akentros/*` 只供介面展示,不得參與模型驗證、routing、provider 選擇或計費。
- 前後端 catalog 以 schema 與 CI 檢查 revision、價格、能力、provider、pool 與品牌 manifest 漂移;不一致即阻止建置。

### 4. 安全、資料與計費邊界

- 正式資料表只由 versioned SQL migration 建立;推理 hot path 不執行臨時建表。
- 部署或升級時先執行 `npm run migrate`;Node／Worker request runtime 僅做 readiness 檢查,schema 未就緒時安全失敗。
- Akentros Key secret 只在建立或輪替時回傳一次。資料庫只保存遮罩欄位與使用 pepper 的 HMAC digest。
- provider secret 只存在各 runtime secret;資料庫僅保存 opaque credential ID 與健康／lease 狀態。
- prompt、completion、完整 Akentros Key 與 provider token 不寫入資料庫、log 或 error response。
- 計費採「預留上限、依可信 usage 結算、退回差額」;reservation、settlement、refund 與 idempotency 必須可重跑且不重複扣退。
- credential 輪詢、健康狀態及 in-flight lease 以共享 PostgreSQL 協調,不使用 isolate-local cursor 作全域狀態。

### 5. 啟用條件

`/api/ai/*` 由 `AKENTROS_ENABLED` 控制,fail-closed:未明確設為 `true` 時整個入口不存在(404)。啟用前至少應驗收:點數不足時 provider attempt 為零、無負餘額或雙扣、Node／Worker 契約一致、SSE 首個 data chunk 後不 fallback、秘密與內容不落地,以及控制台 deep link／無障礙驗收通過。

## 後果

- 真實 provider 串接晚於 migration、fake provider 計費狀態機與故障測試。
- 新功能初期需要額外的 schema、契約與 parity 測試,但可避免前端展示資料或單一 runtime 悄悄成為第二權威。
- 若公開價格、API shape、資料保存政策或 fallback 規則改變,必須新增或取代 ADR,不能只修改其中一個 runtime。
- Responses、Embeddings、Images、Audio、Realtime、vision、tools、BYOK 與跨模型 fallback 均不在本決策的第一版範圍內。
