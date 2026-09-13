import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { BEACON_SCHEMA_VERSION } from "../../../packages/core/src/schemaMigration.ts";
import { ensureBeaconSchemaReady, seedBeaconAdminFromEnv } from "../src/utils/bootstrap.ts";
import { closePostgresClients, installNodeBeaconDbAdapter } from "../src/utils/db.ts";

// 遷移流程(與 Workers DO 首次啟動共用 ensureBeaconSchemaReady/
// seedBeaconAdminFromEnv,見 src/utils/bootstrap.ts):
//   1. point_transactions(AI 計費流水的平台層底表)
//   2. Beacon schema(版本化遷移)
//   3. users(內建帳號系統)+ 可選管理員種子(ADMIN_EMAIL / ADMIN_PASSWORD)

dotenv.config({
  path: fileURLToPath(new URL("../.dev.vars", import.meta.url)),
  quiet: true,
});

try {
  await installNodeBeaconDbAdapter();

  const { migrated } = await ensureBeaconSchemaReady(process.env);

  const seeded = await seedBeaconAdminFromEnv(process.env);
  if (seeded) {
    const adminEmail = process.env.ADMIN_EMAIL?.trim();
    console.log(
      seeded.created
        ? `Admin account ready for ${adminEmail} (password not printed).`
        : `Admin account already exists for ${adminEmail}; role ensured.`,
    );
  } else {
    console.log("ADMIN_EMAIL/ADMIN_PASSWORD not set; skipped admin bootstrap.");
  }

  console.log(
    `Beacon schema is ready at version ${BEACON_SCHEMA_VERSION} ` +
      `(${migrated ? "migrated" : "already ready"}).`,
  );
} catch (error: any) {
  console.error("Beacon schema migration failed:", error?.message || error);
  process.exitCode = 1;
} finally {
  await closePostgresClients();
}
