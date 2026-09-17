import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createBeaconQuery,
  dbGet,
  dbQuery,
  installBeaconDbAdapter,
  withBeaconTransaction,
} from "../src/utils/db.ts";
import { resolveDatabasePath } from "../src/utils/db.node.ts";

// adapter 註冊點契約:進入點安裝後,查詢介面導向該實作;
// createBeaconQuery 必須保持同步(既有呼叫端直接 const query = createBeaconQuery(env))。

// 相對 BEACON_DB_PATH 的解析不得依賴 process.cwd():npm run dev:gateway
// 從 repo 根執行,npm run migrate 在 apps/gateway 內執行;若以 cwd 為基準,
// 兩者會開到不同的 beacon.db(migrate 成功、server no such table: users)。
test("relative BEACON_DB_PATH anchors to the gateway package, independent of cwd", () => {
  const gatewayRoot = fileURLToPath(new URL("../", import.meta.url));
  const originalCwd = process.cwd();
  try {
    process.chdir(path.dirname(gatewayRoot)); // repo 根 = dev:gateway 的 cwd
    assert.equal(resolveDatabasePath({}), path.join(gatewayRoot, "beacon.db"));
    assert.equal(
      resolveDatabasePath({ BEACON_DB_PATH: "./data/beacon.db" }),
      path.join(gatewayRoot, "data", "beacon.db"),
    );
    assert.equal(
      resolveDatabasePath({ BEACON_DB_PATH: "sqlite://./data/beacon.db" }),
      path.join(gatewayRoot, "data", "beacon.db"),
    );
    process.chdir(gatewayRoot); // migrate 的 cwd,解析結果必須相同
    assert.equal(resolveDatabasePath({}), path.join(gatewayRoot, "beacon.db"));
  } finally {
    process.chdir(originalCwd);
  }
});

test("absolute, :memory: and file: database paths keep their literal meaning", () => {
  const absolute = path.resolve(process.cwd(), "elsewhere", "beacon.db");
  assert.equal(resolveDatabasePath({ BEACON_DB_PATH: absolute }), absolute);
  assert.equal(resolveDatabasePath({ BEACON_DB_PATH: ":memory:" }), ":memory:");
  // 前綴剝離後為絕對路徑者,原樣保留(POSIX 與 Windows 皆然)。
  assert.equal(resolveDatabasePath({ BEACON_DB_PATH: "file:/var/lib/beacon/db.sqlite" }), "/var/lib/beacon/db.sqlite");
  assert.equal(
    resolveDatabasePath({ DATABASE_URL: "sqlite:///var/lib/beacon/db.sqlite" }),
    "/var/lib/beacon/db.sqlite",
  );
});

test("db helpers route to the installed adapter", async () => {
  const calls: any[] = [];
  const coreQuery = async (sql: string, params: any[] = []) => {
    calls.push(["core-query", sql, params]);
    return { rows: [] };
  };
  (coreQuery as any).transaction = async (fn: () => Promise<any>) => {
    calls.push(["core-tx"]);
    return fn();
  };
  installBeaconDbAdapter({
    dbQuery: async (_env: any, sql: string, params: any[] = []) => {
      calls.push(["query", sql, params]);
      return { rows: [{ n: 1 }] };
    },
    dbGet: async () => null,
    withBeaconTransaction: async (_env: any, fn: () => Promise<any>) => {
      calls.push(["tx"]);
      return fn();
    },
    createBeaconQuery: (env: any) => {
      calls.push(["create-query", env?.tag]);
      return coreQuery;
    },
    closePostgresClients: async () => {
      calls.push(["close"]);
    },
  });

  assert.deepEqual(await dbQuery({ tag: "env" }, "SELECT 1", [7]), { rows: [{ n: 1 }] });
  assert.equal(await dbGet({}, "SELECT 1"), null);
  assert.equal(await withBeaconTransaction({}, async () => "ok"), "ok");

  const query = createBeaconQuery({ tag: "core" });
  assert.equal(typeof query, "function", "createBeaconQuery must stay synchronous");
  assert.equal(typeof (query as any).transaction, "function");
  await query("SELECT 2", [1]);

  assert.deepEqual(
    calls.map(([kind]) => kind),
    ["query", "tx", "create-query", "core-query"],
  );
  assert.deepEqual(calls[0].slice(1), ["SELECT 1", [7]]);
  assert.deepEqual(calls[2].slice(1), ["core"]);
});
