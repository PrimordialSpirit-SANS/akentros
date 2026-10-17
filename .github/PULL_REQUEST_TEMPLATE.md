<!--
ECO-COMM-3 — PR checklist mirroring CONTRIBUTING.md's five rules.
填寫後移除不適用的段落;審查者會以此清單對照。
-->

## 摘要

<!-- 這個 PR 做了什麼、為什麼(動機)。一個 PR 聚焦一件事。 -->

## 追蹤編號

<!-- 若對應稽核/缺陷項目,請填編號(ECO-* / SEC-* / FUNC-* / N* / DEFECT_REPORT #);
     沒有對應項目且屬新議題,請先開 issue 連結於此。 -->

Refs #

## 變更類型

- [ ] 修 bug(附重現測試)
- [ ] 新功能(附測試)
- [ ] 契約變更(OpenAPI / catalog / 路由不變式)
- [ ] 文件
- [ ] 工具鏈 / 建置 / CI
- [ ] 其他(說明)

## 檢查清單

- [ ] `npm run typecheck && npm test` 全數通過(本機已執行)
- [ ] 公開 API 行為有變更時:**先**更新 `docs/openapi.yaml` 與相關契約測試,實作不早於契約
- [ ] 定價 / catalog 變更僅動 `packages/core/config/backend-pricing.v1.json`(權威),展示側未手改
- [ ] 無秘密落地:prompt、completion、完整金鑰、provider token 不入 DB / log / 錯誤回應
- [ ] schema 變更一律走 `packages/core/src/schemaMigration.ts` 版本化遷移,含升級路徑測試
- [ ] CHANGELOG 已補條目(含追蹤編號)
- [ ] 檔案/文件同步更新(README、docs/、examples/ 如受影響)
