"""SSE 串流:SDK 的 stream API 直接可用;usage 出現在最後一個
带 stream_options.include_usage 的 chunk(與 OpenAI 一致)。
"""
import os

from openai import OpenAI

base_url = os.environ.get("AKENTROS_BASE_URL", "http://localhost:8787/api/ai/v1")
api_key = os.environ.get("AKENTROS_API_KEY")
if not api_key:
    raise SystemExit("請先設定 AKENTROS_API_KEY(在控制台「金鑰」頁建立)")

client = OpenAI(base_url=base_url, api_key=api_key)

stream = client.chat.completions.create(
    model=os.environ.get("AKENTROS_MODEL", "akentros/gpt-5.2"),
    messages=[{"role": "user", "content": "從 1 數到 10,每個數字一行。"}],
    stream=True,
    stream_options={"include_usage": True},
)

for chunk in stream:
    if chunk.choices and chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)
    if chunk.usage:
        # 串流的 usage 在終止 chunk 上;計費以此為準
        print("\n用量:", chunk.usage, file=os.sys.stderr)
