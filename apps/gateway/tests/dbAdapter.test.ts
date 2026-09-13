import assert from "node:assert/strict";
import test from "node:test";
import {
  createBeaconQuery,
  dbGet,
  dbQuery,
  installBeaconDbAdapter,
  withBeaconTransaction,
} from "../src/utils/db.ts";

// adapter 註冊點契約:進入點安裝後,查詢介面導向該實作;
// createBeaconQuery 必須保持同步(既有呼叫端直接 const query = createBeaconQuery(env))。

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
