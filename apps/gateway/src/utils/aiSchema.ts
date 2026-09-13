import { assertBeaconSchemaReady } from "../../../../packages/core/src/schemaReadiness.ts";
import { dbQuery } from "./db.ts";

const schemaPromises = new Map();

function databaseKey(env: any) {
  return env?.POSTGRES_DB_URL?.trim() || env?.DATABASE_URL?.trim() || "unconfigured-main";
}

export function ensureAiSchema(env: any) {
  const key = databaseKey(env);
  if (schemaPromises.has(key)) return schemaPromises.get(key);

  const promise = (async () => {
    await assertBeaconSchemaReady((sql: any, params: any[] = []) => dbQuery(env, sql, params));
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
