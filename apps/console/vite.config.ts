import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // 本機開發:把 /api 代理到 Node gateway,讓 console 與 API 同源,
    // SameSite=Lax 的登入 cookie(localhost ≠ 127.0.0.1,跨站會被瀏覽器丟棄)才能保存。
    proxy: {
      "/api": "http://127.0.0.1:8787",
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
