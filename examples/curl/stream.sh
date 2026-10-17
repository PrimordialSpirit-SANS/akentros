#!/usr/bin/env sh
# 零依賴範例:SSE 串流的原始 HTTP 形態。
# -N 關閉 curl 緩衝(逐行即時輸出);「data: [DONE]」為串流終止信號。
# 環境變數同 chat.sh。
set -eu

BASE_URL="${AKENTROS_BASE_URL:-http://localhost:8787/api/ai/v1}"
MODEL="${AKENTROS_MODEL:-akentros/gpt-5.2}"

if [ -z "${AKENTROS_API_KEY:-}" ]; then
  echo "請先設定 AKENTROS_API_KEY(在控制台「金鑰」頁建立)" >&2
  exit 1
fi

curl -sS -N "$BASE_URL/chat/completions" \
  -H "Authorization: Bearer $AKENTROS_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d "$(printf '{
    "model": "%s",
    "messages": [{"role": "user", "content": "從 1 數到 10,每個數字一行。"}],
    "stream": true,
    "stream_options": {"include_usage": true}
  }' "$MODEL")"
echo
