# 品牌資產政策(Brand Assets)

本專案的 `apps/console/public/brand/akentros/` 包含:

1. **自有標誌** `models/akentros.svg`(Akentros 信號燈塔標誌,MIT 授權隨本專案散布)。
2. **官方第三方圖示** `providers/*.svg`、`providers/*.png`——自 2026-09-14 起,
   模型目錄改用各家**官方品牌圖示**,已從官方網站或權威公開來源下載為本地檔案,
   供自架控制台離線顯示。`providers/manifest.v1.json` 的
   `display_asset_url` 一律指向本地檔,`official_asset_url` 與
   `source_page_url` 保留原始下載來源,`attribution` 欄位逐一標注商標所有權人。

## 目前收錄的官方圖示

| 檔案 | 品牌 | 下載來源 |
| --- | --- | --- |
| `openai.svg` | OpenAI | Wikimedia Commons(`OpenAI logo 2025 (symbol).svg`,官方標誌) |
| `anthropic.svg` | Anthropic / Claude | Wikimedia Commons(`Claude AI symbol.svg`,官方星芒標誌) |
| `google.svg` | Google Gemini | Wikimedia Commons(`Google Gemini icon 2025.svg`,官方 Sparkle 圖示) |
| `xai.svg` | xAI | Wikimedia Commons(`XAI Logo.svg`,官方標誌;已裁切 viewBox 對齊圖形) |
| `deepseek.svg` | DeepSeek | Wikimedia Commons(`DeepSeek-icon.svg`,官方鯨魚圖示) |
| `qwen.svg` | Qwen | Wikimedia Commons(`Qwen logo.svg`,官方標誌) |
| `moonshot.png` | Moonshot AI (Kimi) | kimi.com 官方 PWA 圖示(`pwa-192.png`) |
| `z-ai.svg` | Z.ai(智譜) | Z.ai 官方 CDN(`z-cdn.chatglm.cn/z-ai/static/logo.svg`) |
| `cloudflare.png` | Cloudflare | cloudflare.com 官方 favicon |

## 商標歸屬與再散布提醒

OpenAI、Anthropic、Google、xAI、DeepSeek、Kimi (Moonshot AI)、Z.ai (智譜)、
Qwen、Cloudflare 等商標由各自權利人所有。於自架控制台以圖示標示「本閘道可轉發
該供應商模型」屬指示性使用;若你要將本 repo 再散布或商業化,請自行確認各商標的
使用授權範圍。各條目的 `attribution` 已逐項標注所有權人,移除某品牌時請同步
刪除其圖示檔與 manifest 條目。

## 營運者如何替換或新增圖示

1. 將取得的圖檔放到 `apps/console/public/brand/akentros/providers/<id>.svg`
   (或 `.png`;`<img>` 支援 SVG 與點陣圖)。
2. 編輯 `providers/manifest.v1.json`,把對應條目的 `display_asset_url`
   指向該本地路徑,並更新 `official_asset_url`、`source_page_url`、
   `attribution` 三個來源欄位。
3. 模型卡以 `owner_brand_asset_id` 對應 `kind: "model-owner"` 條目;
   供應商徽章以 offering 的 `brand_asset_id` 對應 `kind: "provider"` 條目。
   圖示載入失敗時,介面自動退回「字母徽章」顯示,不影響功能。
