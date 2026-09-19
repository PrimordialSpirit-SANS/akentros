# @akentros/console — Akentros 開發者控制台

Akentros Gateway 的前端(React + Vite + TypeScript)。`src/pages/` 與 `src/components/` 是全新撰寫的控制台 UI(側邊欄式佈局、登入/註冊、Playground);`src/lib/akentros/` 是有測試覆蓋的邏輯層(SSE parser、錯誤正規化、catalog 載入、格式化);`src/services/` 是與 gateway 之間的整合接縫。

## 快速開始

```bash
npm install        # 建議在 repo 根目錄執行(npm workspaces)
npm run dev        # 開發伺服器:http://localhost:5173
npm test           # vitest 單元測試(邏輯層 63 個測試)
npm run build      # 型別檢查 + 生產建置到 dist/
npm run preview    # 預覽生產建置
```

### 離線示範模式(不需後端)

開發或部署後,用網址參數直接進入示範模式:

```
http://localhost:5173/?demo=1
```

或在 `.env` 設 `VITE_AKENTROS_DEMO=1`。示範模式會以 fetch 攔截器(`src/services/demoApi.ts`)提供記憶體內的假資料與模擬 SSE 串流:金鑰建立/輪替/撤銷、用量摘要、請求紀錄、串流測試(帳戶與 API Key 兩種認證)都可以完整操作,資料在重新整理後重置,畫面右下角會顯示「示範模式」標籤。

## 環境變數(見 `.env.example`)

| 變數 | 說明 |
| --- | --- |
| `VITE_AKENTROS_API_BASE` | `apiFetch` 的目標前綴,預設 `/api`。後端 Worker 跑在本機時設 `http://127.0.0.1:8787/api` |
| `VITE_AKENTROS_PUBLIC_API_BASE` | 對外展示的公開 API 根位址(總覽/快速開始頁顯示、API Key 模式串流的端點),預設 `window.location.origin` |
| `VITE_AKENTROS_DEMO` | `1` 時啟用離線示範模式 |

## 接上真實後端

1. gateway(`apps/gateway`)掛載 `/api/auth/*`(註冊/登入)、`/api/ai/developer/*`(管理面,登入 cookie + CSRF)與 `/api/ai/v1/*`(OpenAI 相容公開端點)。
2. `src/services/api.ts` 是邏輯層呼叫後端的**唯一**接縫,契約:
   - `apiFetch(path, init)`:把請求送到 `${VITE_AKENTROS_API_BASE}${path}`,附帶 cookie session(`credentials: 'include'`)與 `X-CSRF-Token`(讀自 `csrf_token` cookie;登入後由 gateway 發下)。401 時控制台會顯示「請先登入」。
   - `getExternalDeveloperApiBase()`:回傳公開 API 根位址。
3. 模型目錄與品牌圖示來自 `public/data/akentros/` 與 `public/brand/akentros/`(靜態檔案,僅介面展示;品牌政策見 `docs/BRAND_ASSETS.md`)。

## 路由

| 路徑 | 頁面 |
| --- | --- |
| `/` | 轉址到 `/Developer/ai-api` |
| `/Developer` | 開發者專區首頁(獨立版簡易實作) |
| `/Developer/ai-api` | 控制台總覽 |
| `/Developer/ai-api/keys` | API 金鑰 |
| `/Developer/ai-api/test` | 串流測試 |
| `/Developer/ai-api/docs` | 快速開始 |
| `/Developer/ai-api/models` | 模型 |
| `/Developer/ai-api/providers` | 供應商 |
| `/Developer/ai-api/logs` | 請求紀錄 |

## 部署注意

- `npm run build` 產出 `dist/`(靜態檔案)。使用 BrowserRouter,靜態託管需設定 **SPA fallback**(所有路徑回 `index.html`)。
