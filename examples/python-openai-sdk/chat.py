"""最小接入:官方 openai 套件指向 Akentros 的 base_url 即可。

環境變數:
  AKENTROS_BASE_URL  gateway 位址(預設 http://localhost:8787/api/ai/v1)
  AKENTROS_API_KEY   在控制台「金鑰」頁建立的 sk-akentros-* 金鑰
"""
import os

from openai import OpenAI

base_url = os.environ.get("AKENTROS_BASE_URL", "http://localhost:8787/api/ai/v1")
api_key = os.environ.get("AKENTROS_API_KEY")
if not api_key:
    raise SystemExit("請先設定 AKENTROS_API_KEY(在控制台「金鑰」頁建立)")

client = OpenAI(base_url=base_url, api_key=api_key)

completion = client.chat.completions.create(
    model=os.environ.get("AKENTROS_MODEL", "akentros/gpt-5.2"),
    messages=[{"role": "user", "content": "用一句話介紹你自己。"}],
)

print("回覆:", completion.choices[0].message.content)
print("用量:", completion.usage)
# usage 是計費依據(預留→依實際 usage 結算→差額退回),金額會反應在控制台「用量」頁
