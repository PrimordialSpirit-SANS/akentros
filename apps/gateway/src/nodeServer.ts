// Node 自架進入點:@hono/node-server 起 HTTP server,
// setInterval(預設每 30 分鐘)做與 Cloudflare cron 相同的維運:
// 清理過期 rate limit bucket 並對帳滯留的保留單。
// 環境設定從 apps/gateway/.dev.vars(dotenv)讀入。

import "dotenv/config";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import dotenv from "dotenv";
import { createApp } from "./app.ts";
import type { BeaconRuntimeEnv } from "./types.ts";
import { installNodeBeaconDbAdapter } from "./utils/db.ts";
import { logBeaconEvent } from "./utils/logger.ts";
import { runBeaconMaintenance } from "./utils/maintenance.ts";

// .dev.vars 相對於此檔;dotenv/config 預設只讀 .env,這裡補載 .dev.vars。
dotenv.config({
  path: fileURLToPath(new URL("../.dev.vars", import.meta.url)),
  quiet: true,
  override: false,
});

// Node 自架部署:啟動時安裝 node:sqlite adapter(Workers 部署由 DO 建構子
// 安裝 storage.sql adapter,見 src/worker/)。
await installNodeBeaconDbAdapter();

const env = process.env as BeaconRuntimeEnv;

const port = Number(env.BEACON_PORT || env.PORT || 8787);

const intervalMs = Number(env.BEACON_MAINTENANCE_INTERVAL_MS) || 30 * 60_000;

// 關機緩衝:等在途請求自然完成;逾時後主動斷開仍在串流的連線(SSE 等)。
const SHUTDOWN_GRACE_MS = 3_000;
// 關機硬上限:無論斷開流程結果如何都強制退出,避免掛死。
const SHUTDOWN_HARD_TIMEOUT_MS = 10_000;

function socketRemoteAddress(incoming: unknown): string {
  try {
    const address = (incoming as { socket?: { remoteAddress?: unknown } } | undefined)?.socket?.remoteAddress;
    return typeof address === "string" && address ? address : "";
  } catch {
    return "";
  }
}

// Hono app 只建一次:每個請求重建整個 app(路由註冊、中介層組裝)只是
// 配置與 GC 的浪費。env 為 process.env 的活引用,設定仍即時生效。
const app = createApp(env);

const server = serve(
  {
    // 第二個參數是 @hono/node-server 的連線綁定({ incoming, outgoing })。
    // 把 socket 來源位址以 BEACON_REMOTE_ADDR 注入每請求 env 供 auth 限流
    // 使用(見 routes/auth.ts);其餘照抄 env,行為與其他部署一致。
    fetch: (request, binding) => {
      const perRequestEnv = {
        ...env,
        BEACON_REMOTE_ADDR: socketRemoteAddress((binding as { incoming?: unknown } | undefined)?.incoming),
      };
      return app.fetch(request, perRequestEnv as unknown as typeof env);
    },
    port,
  },
  (info) => {
    logBeaconEvent("info", "beacon_gateway_listening", {
      port: info.port,
      maintenanceIntervalMinutes: Math.round(intervalMs / 60_000),
    });
  },
);

// 追蹤活躍連線:Node 的 server.close() 回呼要等所有連線結束,未斷開的
// SSE 串流(長時間推論)會讓它永遠不觸發、關機流程掛住。
const sockets = new Set<import("node:net").Socket>();
server.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});

const maintenanceTimer = setInterval(() => {
  runBeaconMaintenance(env).catch((error: any) => {
    logBeaconEvent("error", "beacon_scheduled_maintenance_failed", {
      errorCode: error?.code || error?.name || "unknown",
    });
  });
}, intervalMs);
maintenanceTimer.unref?.();

async function shutdown() {
  clearInterval(maintenanceTimer);
  // 硬上限:即使 close 回呼因故不觸發,程序也會在限期內退出。
  const hardExit = setTimeout(() => process.exit(0), SHUTDOWN_HARD_TIMEOUT_MS);
  hardExit.unref();
  // 緩衝後主動斷開仍在串流的連線,讓 server.close() 的回呼得以觸發。
  const forceClose = setTimeout(() => {
    for (const socket of sockets) socket.destroy();
  }, SHUTDOWN_GRACE_MS);
  forceClose.unref();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  clearTimeout(forceClose);
  clearTimeout(hardExit);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
