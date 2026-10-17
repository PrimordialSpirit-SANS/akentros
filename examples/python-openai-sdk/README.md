# Python + OpenAI SDK

官方 `openai` 套件(v1.x)指向 gateway 的 `base_url` 即可。

```bash
python -m venv .venv && source .venv/bin/activate   # 或慣用的環境管理
pip install -r requirements.txt
export AKENTROS_API_KEY=sk-akentros-live_...        # 控制台建立
export AKENTROS_BASE_URL=http://localhost:8787/api/ai/v1
python chat.py        # 基本 chat/completions
python stream.py      # SSE 串流(含終止 chunk 的 usage)
```

## 檔案

| 檔案 | 展示 |
| --- | --- |
| `chat.py` | 最小接入:`OpenAI(base_url=…, api_key=…)` |
| `stream.py` | 串流 + `stream_options={"include_usage": True}`(計費依據) |

## Python 側的冪等

Python SDK 支援 per-request headers(與 Node 範例同語義):

```python
completion = client.chat.completions.create(
    model="akentros/gpt-5.2",
    messages=[...],
    extra_headers={"Idempotency-Key": f"demo-{uuid.uuid4()}"},
)
```

同一個鍵重送的行為(409 語義 / opt-in 重放)見 `../node-openai-sdk/idempotency.mjs` 的註解——跨語言一致,由 gateway 端定義。
