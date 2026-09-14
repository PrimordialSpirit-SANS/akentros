import { assertBeaconSchemaReady } from "@beacon/core/schemaReadiness";
import type { BeaconRuntimeEnv } from "../types.ts";
import { dbQuery } from "./db.ts";

const schemaPromises = new Map();

function databaseKey(env: BeaconRuntimeEnv) {
  return env?.DATABASE_URL?.trim() || "unconfigured-main";
}

export function ensureAiSchema(env: BeaconRuntimeEnv) {
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
