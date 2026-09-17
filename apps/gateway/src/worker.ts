// Cloudflare Workers 進入點。公開 fetch 與 cron(scheduled)都只做一件事:
// 指向單一 BeaconGateway Durable Object(整個 Hono app + SQLite 都在 DO 內)。
//
// - 公開流量一律轉發;/internal/maintenance 是 scheduled 事件專屬路徑,
//   Worker 在轉發前擋下,避免外部請求觸發對帳。
// - DO binding(BEACON_DO)與 class 遷移見 wrangler.jsonc;singleton 由
//   idFromName 固定,不得分片(計費/限流不變式,見 gatewayDo.ts)。

export { BeaconGateway } from "./worker/gatewayDo.ts";

import { logBeaconEvent } from "./utils/logger.ts";

interface BeaconDoId {
  toString(): string;
}

interface BeaconDoStub {
  fetch(request: Request): Promise<Response>;
}

interface BeaconDoNamespace {
  idFromName(name: string): BeaconDoId;
  get(id: BeaconDoId): BeaconDoStub;
}

interface WorkerEnv {
  BEACON_DO?: BeaconDoNamespace;
}

const MAINTENANCE_PATH = "/internal/maintenance";

function beaconDoStub(env: WorkerEnv): BeaconDoStub {
  const namespace = env?.BEACON_DO;
  if (!namespace) {
    throw new Error("BEACON_DO binding is missing: check durable_objects in apps/gateway/wrangler.jsonc.");
  }
  return namespace.get(namespace.idFromName("beacon-gateway"));
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === MAINTENANCE_PATH) {
      return Response.json({ error: "Not found.", code: "not_found" }, { status: 404 });
    }
    return beaconDoStub(env).fetch(request);
  },

  async scheduled(
    _event: unknown,
    env: WorkerEnv,
    ctx: { waitUntil(promise: Promise<unknown>): void },
  ): Promise<void> {
    ctx.waitUntil(
      beaconDoStub(env)
        .fetch(new Request(`https://beacon-gateway.internal${MAINTENANCE_PATH}`))
        .then((response) => {
          if (!response.ok) {
            logBeaconEvent("error", "beacon_scheduled_maintenance_failed", {
              httpStatus: response.status,
            });
          }
        }),
    );
  },
};
