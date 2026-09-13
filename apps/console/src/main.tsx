import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./index.css";
import { installBeaconDemoApi, isBeaconDemoMode } from "./services/demoApi";

// 攔截器必須在任何元件發出請求前裝好。
if (isBeaconDemoMode()) {
  installBeaconDemoApi();
  // 把 ?demo=1 補回網址,讓 SPA 導航或重整後仍停留在示範模式。
  const url = new URL(window.location.href);
  if (!url.searchParams.has("demo")) {
    url.searchParams.set("demo", "1");
    window.history.replaceState(null, "", url.toString());
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
