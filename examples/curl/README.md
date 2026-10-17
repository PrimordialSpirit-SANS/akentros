# cURL

零依賴的原始 HTTP 形態——除錯、煙霧測試或對接非 SDK 環境時最有用。

```bash
chmod +x chat.sh stream.sh          # 執行前設一次
export AKENTROS_API_KEY=sk-akentros-live_...
export AKENTROS_BASE_URL=http://localhost:8787/api/ai/v1

./chat.sh                            # JSON 回應
./stream.sh                          # SSE 串流(逐行輸出)
```

## 常用變體

```bash
# 模型目錄(確認可用的 akentros/* 模型與免費額度)
curl -sS "$AKENTROS_BASE_URL/models" -H "Authorization: Bearer $AKENTROS_API_KEY"

# 冪等鍵(同鍵同體重送 → 409 idempotent_request_replayed,或 opt-in 後重播)
curl -sS "$AKENTROS_BASE_URL/chat/completions" \
  -H "Authorization: Bearer $AKENTROS_API_KEY" \
  -H "Idempotency-Key: demo-1" \
  -H "Content-Type: application/json" \
  -d '{"model":"akentros/gpt-5.2","messages":[{"role":"user","content":"回覆「好的」"}]}'

# 健康探針(部署煙霧測試;不需要金鑰)
curl -sS http://localhost:8787/healthz
```

## 注意

- `stream.sh` 的 `-N` 不可省——否則 curl 會緩衝整個串流,失去逐字輸出。
- 串流的 usage 只出現在带 `stream_options.include_usage` 的終止 chunk;計費以此為準。
- 錯誤回應是 OpenAI 形態的 JSON(`{"error": {"code": …, "message": …}}`),`unsupported_feature` / `unsupported_parameter` 等錯誤碼可分辨「不支援」與「壞請求」。
