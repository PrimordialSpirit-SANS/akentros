# 品牌資產政策(Brand Assets)

本專案開源散布時,`apps/console/public/brand/beacon/` 只包含:

1. **自有標誌** `models/beacon.svg`(Beacon 信號燈塔標誌,MIT 授權隨本專案散布)。
2. **中性文字佔位標誌** `providers/*.svg`——圓角方塊加單一字母的自製佔位圖,
   非任何第三方的官方 logo;`providers/manifest.v1.json` 的 `attribution`
   欄位逐一標注各商標的實際所有權人。

## 為什麼第三方 logo 不隨 repo 散布

Meta、OpenAI、Google、Qwen、DeepSeek、Kimi、Z.ai 等商標由各自權利人所有,
未取得明確授權前不應隨開源專案再散布。因此 manifest 中第三方條目的
`display_asset_url` 為 `null`,控制台會自動退回「字母徽章」顯示
(取品牌名稱字首),介面仍可正常使用。

## 營運者如何放回 logo(選配)

自架部署可以在**不修改 repo** 的情況下還原品牌圖示:

1. 將你取得授權(或符合合理使用)的圖檔放到
   `apps/console/public/brand/beacon/models/<brand>.svg`。
2. 編輯 `providers/manifest.v1.json`,把對應條目的
   `display_asset_url` 指向該路徑(例如 `/brand/beacon/models/meta.svg`)。
3. 各條目的 `official_asset_url` 與 `source_page_url` 保留了官方品牌頁連結,
   可作為取得官方素材的起點。

若你希望上游收你維護的官方素材,請先附上各權利人的授權證明再發 PR。
