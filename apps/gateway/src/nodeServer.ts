// Node 自架進入點:@hono/node-server 起 HTTP server,
// setInterval(預設每 30 分鐘)做與 Cloudflare cron 相同的維運:
// 清理過期 rate limit bucket 並對帳滯留的保留單。
// 環境設定從 apps/gateway/.dev.vars(dotenv)讀入。

import "dotenv/config";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import dotenv from "dotenv";
import { createApp } from "./app.ts";
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

const env = process.env;

const port = Number(env.BEACON_PORT || env.PORT || 8787);

const intervalMs = Number(env.BEACON_MAINTENANCE_INTERVAL_MS) || 30 * 60_000;

const server = serve(
  {
    fetch: (request) => createApp(env).fetch(request, env as any),
    port,
  },
  (info) => {
    logBeaconEvent("info", "beacon_gateway_listening", {
      port: info.port,
      maintenanceIntervalMinutes: Math.round(intervalMs / 60_000),
    });
  },
);

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
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
