import { assertAkentrosSchemaReady } from "@akentros/core/schemaReadiness";
import type { AkentrosRuntimeEnv } from "../types.ts";
import { dbQuery } from "./db.ts";

const schemaPromises = new Map();

function databaseKey(env: AkentrosRuntimeEnv) {
  return env?.DATABASE_URL?.trim() || "unconfigured-main";
}

export function ensureAiSchema(env: AkentrosRuntimeEnv) {
  const key = databaseKey(env);
  if (schemaPromises.has(key)) return schemaPromises.get(key);

  const promise = (async () => {
    await assertAkentrosSchemaReady((sql: any, params: any[] = []) => dbQuery(env, sql, params));
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
