import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function read(relativePath: string) {
  return readFileSync(new URL(`../../../${relativePath}`, import.meta.url), "utf8");
}

function collectRoutes(source: string, receiver: string) {
  const pattern = new RegExp(receiver + String.raw`\.(get|post|delete)\(\s*['"]([^'"]+)['"]`, "g");
  return [...source.matchAll(pattern)].map((match) => `${match[1].toUpperCase()} ${match[2]}`).sort();
}

test("Hono exposes the complete Akentros developer route contract", () => {
  const worker = read("apps/gateway/src/routes/aiDeveloper.ts");
  assert.deepEqual(collectRoutes(worker, "aiDeveloperRoutes"), [
    "DELETE /keys/:id",
    "GET /keys",
    "GET /logs",
    "GET /requests/:requestId",
    "GET /usage/summary",
    "POST /chat/completions",
    "POST /keys",
    "POST /keys/:id/rotate",
  ]);
  assert.match(
    read("apps/gateway/src/app.ts"),
    /app\.route\(['"]\/api\/ai\/developer['"],\s*aiDeveloperRoutes\)/,
  );
});

test("developer key routes preserve authorization and secret handling guards", () => {
  const route = read("apps/gateway/src/routes/aiDeveloper.ts");
  const keys = read("apps/gateway/src/utils/aiApiKeys.ts");
  assert.match(route, /authenticateToken/);
  assert.match(route, /isAkentrosServiceRestricted/);
  assert.match(route, /Cache-Control['"], ['"]no-store/);
  assert.match(route, /akentros-key-management/);
  assert.match(route, /AKENTROS_API_KEY_PEPPER_INVALID/);
  assert.doesNotMatch(route, /console\.(?:log|error)\([^\n]*(?:req\.body|api_key|secret)/);
  assert.match(keys, /withAkentrosTransaction/);
  assert.match(keys, /activeCount >= AKENTROS_MAX_ACTIVE_KEYS/);
  assert.match(keys, /AKENTROS_MAX_ACTIVE_KEYS/);
  assert.match(route, /const \{ secret, \.\.\.key \} = created/);
  assert.match(route, /const \{ secret, \.\.\.key \} = rotated/);
});

test("account inference uses a private session credential behind login auth", () => {
  const route = read("apps/gateway/src/routes/aiDeveloper.ts");
  const publicRoute = read("apps/gateway/src/routes/aiPublic.ts");
  const keys = read("apps/gateway/src/utils/aiApiKeys.ts");
  const stream = read("apps/console/src/lib/akentros/api/akentrosChatStream.ts");
  const page = read("apps/console/src/pages/PlaygroundPage.tsx");

  assert.match(route, /authenticateToken/);
  assert.match(route, /post\(['"]\/chat\/completions['"]/);
  assert.match(route, /ensureAkentrosSessionCredential/);
  assert.match(route, /handleAkentrosChatCompletions/);
  assert.match(publicRoute, /authenticateAkentrosKey/);
  assert.match(publicRoute, /handleAkentrosChatCompletions/);
  assert.match(keys, /environment <> 'session'/);
  assert.match(keys, /public-key authentication excludes/);
  assert.match(stream, /getAkentrosAccountChatCompletionsPath/);
  assert.match(stream, /authMode === ['"]account['"] \? apiFetch : fetch/);
  assert.match(page, /sk-akentros-live/);
});

test("Hono key lifecycle and public authentication enforce the shared contract", () => {
  const route = read("apps/gateway/src/routes/aiDeveloper.ts");
  const keys = read("apps/gateway/src/utils/aiApiKeys.ts");
  const auth = read("apps/gateway/src/middleware/aiAuth.ts");
  assert.match(keys, /AND is_active = 1/);
  assert.match(keys, /AND revoked_at IS NULL/);
  assert.match(keys, /revoked_at = COALESCE\(revoked_at, \?\)/);
  assert.match(route, /revoke[\s\S]*204/);
  for (const code of ["invalid_api_key", "account_banned", "service_restricted", "insufficient_scope"])
    assert.match(auth, new RegExp(code));
});

test("Standalone gateway pins the Node entrypoint and workspace scripts", () => {
  const entrypoint = read("apps/gateway/src/nodeServer.ts");
  const maintenance = read("apps/gateway/src/utils/maintenance.ts");
  const scripts = JSON.parse(read("package.json")).scripts;
  assert.match(entrypoint, /@hono\/node-server/);
  assert.match(entrypoint, /installNodeAkentrosDbAdapter/);
  // 維護迴圈本體由共用模組提供;進入點必須呼叫它,不得自帶一份。
  assert.match(entrypoint, /runAkentrosMaintenance/);
  assert.match(maintenance, /cleanupAkentrosRateLimitBuckets/);
  assert.match(maintenance, /reconcileStaleAkentrosReservations/);
  assert.match(maintenance, /resolveQuarantinedAkentrosReservations/);
  assert.match(scripts.migrate, /@akentros\/gateway/);
  assert.match(scripts["dev:gateway"], /nodeServer\.ts/);
});

test("Cloudflare Workers deployment pins the Durable Object topology", () => {
  const worker = read("apps/gateway/src/worker.ts");
  const doClass = read("apps/gateway/src/worker/gatewayDo.ts");
  const doAdapter = read("apps/gateway/src/worker/doDb.ts");
  const wrangler = read("apps/gateway/wrangler.jsonc");
  // Worker 只做轉發與 cron;app 與資料庫都在單一 DO 內。
  assert.match(worker, /export \{ AkentrosGateway \}/);
  assert.match(worker, /idFromName\(/);
  assert.match(worker, /MAINTENANCE_PATH/);
  assert.match(wrangler, /"class_name": "AkentrosGateway"/);
  assert.match(wrangler, /new_sqlite_classes/);
  assert.match(wrangler, /"crons"/);
  assert.match(wrangler, /nodejs_compat/);
  // DO 建構子安裝 storage.sql adapter;首次請求前完成遷移與管理員種子。
  assert.match(doClass, /installAkentrosDbAdapter\(createDoAkentrosDbAdapter/);
  assert.match(doClass, /ensureAkentrosSchemaReady/);
  assert.match(doClass, /seedAkentrosAdminFromEnv/);
  assert.match(doClass, /runAkentrosMaintenance/);
  // DO SQL 禁交易語句:原子性必須走 storage.transaction,其他查詢排隊。
  assert.match(doAdapter, /storage\.transaction/);
  assert.match(doAdapter, /txOpen/);
  assert.match(doAdapter, /flushPending/);
  assert.doesNotMatch(doAdapter, /BEGIN IMMEDIATE/);
  // 不得呼叫 blockConcurrencyWhile(會延遲事件交付,callback 一旦 await
  // runtime I/O 即死鎖;註解提及但無呼叫是允許的)。
  assert.doesNotMatch(doAdapter, /\.blockConcurrencyWhile\(/);
  assert.doesNotMatch(read("apps/gateway/src/worker/gatewayDo.ts"), /\.blockConcurrencyWhile\(/);
  // dispatcher 不得把 node:sqlite 靜態拉進 worker bundle。
  assert.doesNotMatch(read("apps/gateway/src/utils/db.ts"), /from "\.\/db\.node\.ts"/);
});
test("Hono exposes the public Akentros inference routes", () => {
  const worker = read("apps/gateway/src/routes/aiPublic.ts");
  assert.deepEqual(collectRoutes(worker, "aiPublicRoutes"), [
    "GET /models",
    "POST /chat/completions",
    "POST /embeddings",
  ]);
  assert.match(read("apps/gateway/src/app.ts"), /app\.route\(['"]\/api\/ai\/v1['"],\s*aiPublicRoutes\)/);
});
