import { assertAkentrosSchemaReady } from "@akentros/core/schemaReadiness";
import type { AkentrosRuntimeEnv } from "../types.ts";
import { createAkentrosQuery } from "./db.ts";

const schemaPromises = new Map();

function databaseKey(env: AkentrosRuntimeEnv) {
  return env?.DATABASE_URL?.trim() || "unconfigured-main";
}

export function ensureAiSchema(env: AkentrosRuntimeEnv) {
  const key = databaseKey(env);
  if (schemaPromises.has(key)) return schemaPromises.get(key);

  const promise = (async () => {
    // createAkentrosQuery 提供 dialect 標註:就緒檢查依此選擇 SQLite/PostgreSQL
    // 的 catalog 語法(裸函式包裝會被誤判為 SQLite)。
    await assertAkentrosSchemaReady(createAkentrosQuery(env));
  })().catch((error: any) => {
    schemaPromises.delete(key);
    throw error;
  });

  schemaPromises.set(key, promise);
  return promise;
}

export function resetAiSchemaPromiseForTests(databaseUrl: any) {
  if (databaseUrl) schemaPromises.delete(String(databaseUrl).trim());
  else schemaPromises.clear();
}
