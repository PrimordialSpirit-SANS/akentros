# Security Policy

## 通報方式(Reporting a vulnerability)

請**不要**以公開 issue 回報安全問題。

以 GitHub Security Advisories(「Report a vulnerability」)私下通報,
或在無法使用時寄信給維護者(見 repo 首頁)。我們會在收到後盡快回覆,
並在修補發布後公開致謝(除非你希望匿名)。

回報時請附:受影響的元件與路徑、重現步驟、影響評估;若有概念性驗證請附最小版本。

## 修復時程(Supported versions)

僅最新一版獲得安全修補。發布新版後,舊版不會回植修補。

## 設計上已防護的邊界(供測試者參考)

- API 金鑰明文只在建立/輪替時出現一次;落庫為 HMAC-SHA256(pepper) digest + prefix/suffix 遮罩。
- prompt、completion、完整金鑰與 provider token 不入庫、不入 log、不進錯誤回應。
- 供應商 secret 只存在 runtime 環境變數;資料庫僅存 opaque credential ID。
- 管理面請求需登入 cookie(JWT)+ CSRF 雙提交標頭;公開推理面只接受 `sk-akentros-*` Bearer 金鑰,兩者互不可換。
- `AKENTROS_ENABLED` 未明確為 `true` 時,`/api/ai/*` 路由不存在(fail-closed)。

測試時請使用你自己的部署與金鑰,不要對他人部署產生供應商費用。
