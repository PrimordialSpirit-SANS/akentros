# 支援管道(Support)

遇到問題時,請依問題類型選擇對的管道,這樣問題能最快被解決:

| 情境 | 管道 |
| --- | --- |
| 疑似 bug(有重現步驟) | [開 issue](https://github.com/PrimordialSpirit-SANS/akentros/issues/new?template=bug_report.md),請用 bug 範本並附 Node 版本(≥ 22.18)與重現步驟 |
| 功能提案 | [開 issue](https://github.com/PrimordialSpirit-SANS/akentros/issues/new?template=feature_request.md),或到 Discussions 的 Ideas 分類先討論 |
| 使用問題 / 「這樣做對嗎」 | GitHub Discussions 的 Q&A 分類(見下方說明) |
| **安全漏洞** | **不要開公開 issue**——依 [SECURITY.md](SECURITY.md) 以 GitHub Security Advisory 私下通報 |
| 部署問題 | 先查 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)(含各拓撲的煙霧測試與回滾程序),卡住再開 issue |

## Discussions

`CONTRIBUTING.md` 承諾的 Discussions 頻道在 ECO-COMM-5(見
[docs/RELEASING.md](docs/RELEASING.md) 的 one-time platform settings)啟用後,
Q&A 分類是使用問題的首選:提問、回答與「已解決」標記都會累積成可搜尋的
知識庫,不會像 closed issue 一樣沉沒。啟用前的過渡期,使用問題暫以 issue
處理,標題加 `[q]` 前綴。

## 自助資源

多數問題其實不需要人:`README.md` 的設定表與相容性矩陣、
[docs/PROVIDERS.md](docs/PROVIDERS.md)(各供應商怪癖)、
[docs/INTEGRATIONS.md](docs/INTEGRATIONS.md)(框架對接)、
[docs/MIGRATION.md](docs/MIGRATION.md)(從 LiteLLM / one-api 遷移)與
[examples/](../examples/)(可直接執行的 SDK 範例)涵蓋了最常見的接入問題。
控制台的 `?demo=1` 離線示範模式可以在不設定任何供應商金鑰的情況下熟悉全部功能。
