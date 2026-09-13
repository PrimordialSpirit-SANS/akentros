# 貢獻指南

感謝有意見要貢獻!這個專案的重整邊界由 [docs/ADR-0001](docs/ADR-0001-rebuild-boundaries.md) 定義,動手前請先讀它。

## 開發流程

```bash
npm install
npm run typecheck   # 三個 workspace 的 tsc --noEmit
npm test            # packages/core(node --test,SQLite in-memory)+ apps/console(vitest)+ apps/gateway(node --test)
npm run build       # console 生產建置
```

## 規則

1. **契約先行**:改變公開 API 行為前,先更新 `docs/openapi.yaml` 與相關契約測試(`packages/core/tests/openapi-contract.test.ts`、`developer-route-contract.test.ts`),實作差異不得先於契約。
2. **定價與 catalog 權威分離**:`packages/core/config/backend-pricing.v1.json` 是唯一 runtime 權威;`apps/console/public/data/beacon/*` 只供展示。兩邊漂移會被 `config-validation.test.ts` 擋下。
3. **秘密與內容不落地**:prompt、completion、完整金鑰、provider token 不得寫入 DB/log/error response;新程式碼請維持此不變式。
4. **schema 只進不退**:資料表結構一律透過 `packages/core/src/schemaMigration.ts` 的版本化遷移,不寫 ad-hoc DDL。
5. **樣式**:既有程式以繁中註解標注「為什麼」,英文用於對外訊息與錯誤碼;新代碼請遵循同風格。

## Pull Request

- 一個 PR 聚焦一件事;附上動機與測試結果(`npm run typecheck && npm test`)。
- 新功能請附對應測試;修 bug 請附重現測試。
- 不收未經討論的大型重構,請先開 issue 或 discussion。

## 回報問題

- Bug:請附環境(Node 版本 ≥ 22.18)、重現步驟、預期與實際行為。移除任何金鑰與個資。
- 安全問題:見 [SECURITY.md](SECURITY.md),不要開公開 issue。
