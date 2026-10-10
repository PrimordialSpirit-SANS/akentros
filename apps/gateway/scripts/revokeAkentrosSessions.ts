import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { ensureAkentrosSchemaReady } from "../src/utils/bootstrap.ts";
import { closePostgresClients, installNodeAkentrosDbAdapter } from "../src/utils/db.ts";
import { revokeAkentrosSessions } from "../src/utils/users.ts";

// SEC-01 fix:伺服端會話撤銷的管理指令(一次性維運操作,不常駐)。
//   node scripts/revokeAkentrosSessions.ts --all
//   node scripts/revokeAkentrosSessions.ts --id 42
//   node scripts/revokeAkentrosSessions.ts --email user@example.com
//   (亦接受 --id=42 / --email=user@example.com 形式)
//
// 效果:目標帳號(或全站)的 users.session_epoch + 1,該範圍所有已簽發的
// akentros_token JWT 立即失效(authenticateToken 比對 epv 不一致 → 401
// session_revoked),無需輪替 JWT_SECRET —— 輪替會把全站用戶一起登出,
// epoch 撤銷只影響指定範圍。撤銷後使用者重新登入即取得新 epoch 的會話。
// 適用時機:懷疑 token 洩漏、管理員封鎖帳號、(未來)改密碼。
//
// 與 migrate script 相同的環境慣例:Node 部署讀 apps/gateway/.dev.vars,
// DATABASE_URL 設為 postgres:// 時自動切換 PG 方言。先跑 ensureAkentrosSchemaReady
// 保證 users.session_epoch 欄位存在(v4 遷移,冪等),資料庫未就緒的部署
// 也能直接執行此指令。
//
// Workers(DO-SQLite)部署的撤銷:對資料庫執行等價 SQL
//   UPDATE users SET session_epoch = session_epoch + 1;          -- 全站
//   UPDATE users SET session_epoch = session_epoch + 1 WHERE email = '…'; -- 單一帳號
// (DO 的 SQLite 可用 wrangler 的 DO SQL API 或任何 SQLite 用戶端操作。)

dotenv.config({
  path: fileURLToPath(new URL("../.dev.vars", import.meta.url)),
  quiet: true,
});

const USAGE = [
  "Usage:",
  "  node scripts/revokeAkentrosSessions.ts --all",
  "  node scripts/revokeAkentrosSessions.ts --id <user_id>",
  "  node scripts/revokeAkentrosSessions.ts --email <email>",
].join("\n");

function parseTarget(argv: string[]): { all: true } | { userId: string } | { email: string } | null {
  const args = argv.map((arg) => String(arg));
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--all") return { all: true };
    if (arg === "--id") {
      const value = args[index + 1];
      return value ? { userId: value } : null;
    }
    if (arg === "--email") {
      const value = args[index + 1];
      return value ? { email: value } : null;
    }
    if (arg.startsWith("--id=")) {
      const value = arg.slice("--id=".length);
      return value ? { userId: value } : null;
    }
    if (arg.startsWith("--email=")) {
      const value = arg.slice("--email=".length);
      return value ? { email: value } : null;
    }
  }
  return null;
}

try {
  await installNodeAkentrosDbAdapter();

  const target = parseTarget(process.argv.slice(2));
  if (!target) {
    console.error(USAGE);
    process.exitCode = 1;
  } else {
    // 冪等:v4 未套用的舊資料庫會在此補上 session_epoch 欄位。
    await ensureAkentrosSchemaReady(process.env);

    const { revoked } = await revokeAkentrosSessions(process.env, target);
    if (revoked === 0) {
      console.log("No matching accounts; nothing revoked.");
    } else if ("all" in target) {
      console.log(`Revoked all sessions for every account (${revoked} total).`);
    } else {
      console.log(`Revoked all sessions for ${revoked} account(s).`);
    }
  }
} catch (error: any) {
  console.error("Akentros session revocation failed:", error?.message || error);
  process.exitCode = 1;
} finally {
  await closePostgresClients();
}
