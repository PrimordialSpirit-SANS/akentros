import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  dbQuery as nodeDbQuery,
  withAkentrosTransaction as nodeWithAkentrosTransaction,
  resolveDatabasePath,
} from "../src/utils/db.node.ts";
import {
  createAkentrosQuery,
  dbGet,
  dbQuery,
  installAkentrosDbAdapter,
  withAkentrosTransaction,
} from "../src/utils/db.ts";

// adapter 註冊點契約:進入點安裝後,查詢介面導向該實作;
// createAkentrosQuery 必須保持同步(既有呼叫端直接 const query = createAkentrosQuery(env))。

// 相對 AKENTROS_DB_PATH 的解析不得依賴 process.cwd():npm run dev:gateway
// 從 repo 根執行,npm run migrate 在 apps/gateway 內執行;若以 cwd 為基準,
// 兩者會開到不同的 akentros.db(migrate 成功、server no such table: users)。
test("relative AKENTROS_DB_PATH anchors to the gateway package, independent of cwd", () => {
  const gatewayRoot = fileURLToPath(new URL("../", import.meta.url));
  const originalCwd = process.cwd();
  try {
    process.chdir(path.dirname(gatewayRoot)); // repo 根 = dev:gateway 的 cwd
    assert.equal(resolveDatabasePath({}), path.join(gatewayRoot, "akentros.db"));
    assert.equal(
      resolveDatabasePath({ AKENTROS_DB_PATH: "./data/akentros.db" }),
      path.join(gatewayRoot, "data", "akentros.db"),
    );
    assert.equal(
      resolveDatabasePath({ AKENTROS_DB_PATH: "sqlite://./data/akentros.db" }),
      path.join(gatewayRoot, "data", "akentros.db"),
    );
    process.chdir(gatewayRoot); // migrate 的 cwd,解析結果必須相同
    assert.equal(resolveDatabasePath({}), path.join(gatewayRoot, "akentros.db"));
  } finally {
    process.chdir(originalCwd);
  }
});

test("absolute, :memory: and file: database paths keep their literal meaning", () => {
  const absolute = path.resolve(process.cwd(), "elsewhere", "akentros.db");
  assert.equal(resolveDatabasePath({ AKENTROS_DB_PATH: absolute }), absolute);
  assert.equal(resolveDatabasePath({ AKENTROS_DB_PATH: ":memory:" }), ":memory:");
  // 前綴剝離後為絕對路徑者,原樣保留(POSIX 與 Windows 皆然)。
  assert.equal(
    resolveDatabasePath({ AKENTROS_DB_PATH: "file:/var/lib/akentros/db.sqlite" }),
    "/var/lib/akentros/db.sqlite",
  );
  assert.equal(
    resolveDatabasePath({ DATABASE_URL: "sqlite:///var/lib/akentros/db.sqlite" }),
    "/var/lib/akentros/db.sqlite",
  );
});

// 以下兩測試直接驅動 db.node.ts 實作(不經註冊表):交易必須以
// per-database chain 序列化。未序列化時,交易 fn 內含真 I/O 類的 macrotask
// 空檔(setTimeout / WebCrypto threadpool)就會讓第二筆 BEGIN IMMEDIATE
// 撙「cannot start a transaction within a transaction」對外變 503。
test("node adapter serializes overlapping transactions on one database", async () => {
  const env = { AKENTROS_DB_PATH: ":memory:" };
  await nodeDbQuery(
    env as any,
    "CREATE TABLE IF NOT EXISTS tx_serialization_probe (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)",
  );

  const events: string[] = [];
  const first = nodeWithAkentrosTransaction(env as any, async () => {
    await nodeDbQuery(env as any, "INSERT INTO tx_serialization_probe (value) VALUES (1)");
    // macrotask 空檔:若未序列化,第二筆交易會在此期間 BEGIN 而爆炸。
    await new Promise((resolve) => setTimeout(resolve, 25));
    await nodeDbQuery(env as any, "INSERT INTO tx_serialization_probe (value) VALUES (2)");
    events.push("first-committed");
  });
  const second = nodeWithAkentrosTransaction(env as any, async () => {
    await nodeDbQuery(env as any, "INSERT INTO tx_serialization_probe (value) VALUES (3)");
    events.push("second-started");
  });
  await Promise.all([first, second]);

  // 交易依序執行:第一筆完整提交後第二筆才開始(而非並行)。
  assert.deepEqual(events, ["first-committed", "second-started"]);
  const rows = await nodeDbQuery(env as any, "SELECT value FROM tx_serialization_probe ORDER BY id");
  assert.deepEqual(
    rows.rows.map((row: any) => Number(row.value)),
    [1, 2, 3],
  );
});

test("node adapter transaction failure rolls back and releases the chain", async () => {
  const env = { AKENTROS_DB_PATH: ":memory:" };
  await nodeDbQuery(
    env as any,
    "CREATE TABLE IF NOT EXISTS tx_rollback_probe (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)",
  );
  await assert.rejects(
    nodeWithAkentrosTransaction(env as any, async () => {
      await nodeDbQuery(env as any, "INSERT INTO tx_rollback_probe (value) VALUES (1)");
      throw new Error("boom");
    }),
    /boom/,
  );

  // chain 未被 rejection 卡死:下一筆交易照常執行,且 rollback 後資料不在。
  await nodeWithAkentrosTransaction(env as any, async () => {
    await nodeDbQuery(env as any, "INSERT INTO tx_rollback_probe (value) VALUES (2)");
  });
  const rows = await nodeDbQuery(env as any, "SELECT value FROM tx_rollback_probe ORDER BY id");
  assert.deepEqual(
    rows.rows.map((row: any) => Number(row.value)),
    [2],
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
  installAkentrosDbAdapter({
    dbQuery: async (_env: any, sql: string, params: any[] = []) => {
      calls.push(["query", sql, params]);
      return { rows: [{ n: 1 }] };
    },
    dbGet: async () => null,
    withAkentrosTransaction: async (_env: any, fn: () => Promise<any>) => {
      calls.push(["tx"]);
      return fn();
    },
    createAkentrosQuery: (env: any) => {
      calls.push(["create-query", env?.tag]);
      return coreQuery;
    },
    closePostgresClients: async () => {
      calls.push(["close"]);
    },
  });

  assert.deepEqual(await dbQuery({ tag: "env" }, "SELECT 1", [7]), { rows: [{ n: 1 }] });
  assert.equal(await dbGet({}, "SELECT 1"), null);
  assert.equal(await withAkentrosTransaction({}, async () => "ok"), "ok");

  const query = createAkentrosQuery({ tag: "core" });
  assert.equal(typeof query, "function", "createAkentrosQuery must stay synchronous");
  assert.equal(typeof (query as any).transaction, "function");
  await query("SELECT 2", [1]);

  assert.deepEqual(
    calls.map(([kind]) => kind),
    ["query", "tx", "create-query", "core-query"],
  );
  assert.deepEqual(calls[0].slice(1), ["SELECT 1", [7]]);
  assert.deepEqual(calls[2].slice(1), ["core"]);
});
