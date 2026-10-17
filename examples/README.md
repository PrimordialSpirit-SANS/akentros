# Akentros 範例

可直接執行的接入範例,涵蓋最常見的三種呼叫方式。全部範例共用同一組環境約定:

```bash
export AKENTROS_BASE_URL=http://localhost:8787/api/ai/v1   # gateway 位址(含 /api/ai/v1)
export AKENTROS_API_KEY=sk-akentros-live_...               # 在控制台「金鑰」頁建立
```

| 目錄 | 內容 |
| --- | --- |
| [`node-openai-sdk/`](node-openai-sdk/) | Node + 官方 `openai` SDK:基本呼叫、SSE 串流、`Idempotency-Key` 冪等重送 |
| [`python-openai-sdk/`](python-openai-sdk/) | Python + 官方 `openai` SDK:基本呼叫與串流 |
| [`curl/`](curl/) | 零依賴:`chat/completions` 與 SSE 串流的原始 HTTP 形態 |

## 事前準備

1. 讀 [README 快速開始](../README.md#快速開始)把 gateway 跑起來(`npm run migrate` 種子管理員 → 控制台建金鑰)。
2. 沒有供應商金鑰也能走完整流程:控制台 `?demo=1` 示範模式可建金鑰,但真實推理需要 `OPENROUTER_API_KEY_1` 等上游金鑰。
3. 模型名稱帶 `akentros/` 前綴(如 `akentros/gpt-5.2`),可用目錄清單確認:`curl -H "Authorization: Bearer $AKENTROS_API_KEY" $AKENTROS_BASE_URL/models`。

## 行為差異速覽

對照 OpenAI 官方 API 的三個語義差異(詳見 [docs/INTEGRATIONS.md](../docs/INTEGRATIONS.md) 與 `docs/openapi.yaml`):

- **冪等重放**:已完成的 `Idempotency-Key` 重送預設回 `409 idempotent_request_replayed`,不重播回應;需要 OpenAI 式重放可在金鑰上 opt-in TTL(見 `node-openai-sdk/idempotency.mjs`)。
- **不支援的端點**(`images`、`audio`、`moderations`、legacy `completions` 等)回 `400` 並帶可分辨的錯誤碼,不會沉默失敗。
- **`n > 1`** 回 `400 unsupported_feature`,請改送獨立請求(各自冪等)。
