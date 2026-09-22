# Akentros deployment runbook

This runbook intentionally contains no credential values. Run every mutation
against an explicitly selected environment; never rely on an implicit shell
default when migrating or deploying Akentros.

## 0. Supported deployment topologies (read first)

Akentros supports two gateway topologies. Both run the same Hono app and the
same versioned SQLite schema; they differ only in the database adapter and
the maintenance scheduler.

### Topology A: Node server (self-hosted, reference topology)

**`npm run start:gateway` in `apps/gateway` is the reference deployment.**
The server runs on SQLite (`node:sqlite`, Node >= 22.18) and executes the
maintenance loop on an in-process timer (default every 30 minutes,
`AKENTROS_MAINTENANCE_INTERVAL_MS`):

- expired-reservation refunds and quarantined-reservation refunds,
- `ai_rate_limit_buckets` and expired in-flight lease cleanup.

If you place the gateway behind a process manager that suspends the process,
run the reconciliation script (section 4) from an external scheduler instead.

Constraints that apply to every deployment of this topology:

- **Single instance only.** Key-level RPM/concurrency counters, IP rate
  limiting and the billing state machine rely on one SQLite file plus
  in-process serialization (`BEGIN IMMEDIATE` + queued queries). Never run
  two server processes against the same `AKENTROS_DB_PATH`, and never shard
  reads/writes across instances.
- **Persistent local disk** for the database file; backup per section 5.
- **Loopback binding by default.** The Node server binds to `127.0.0.1`
  unless `AKENTROS_HOST` (or `HOST`) is set. To serve traffic from a reverse
  proxy, container, or cluster, set `AKENTROS_HOST=0.0.0.0` (or a specific
  interface address) explicitly and make sure access control — firewall
  rules, proxy ACLs, TLS termination — is in place first. The
  `akentros_gateway_listening` log line records the bound address; verify it
  after every deploy.

### Topology B: Cloudflare Workers (Durable Object)

The same gateway runs on Cloudflare Workers with the entire Hono app + SQLite
inside a **single SQLite-backed Durable Object** (`AkentrosGateway`, see
`apps/gateway/src/worker/`); the Worker entry (`src/worker.ts`) only forwards
requests and cron triggers:

- The DO's `ctx.storage.sql` replaces `node:sqlite`
  (`src/worker/doDb.ts`); multi-statement atomicity uses
  `ctx.storage.transaction(...)` (rollback on throw) — equivalent semantics
  to `BEGIN IMMEDIATE` with queued queries.
- The single-DO-instance model (`idFromName`) preserves the single-writer
  invariant; do not shard or add DO class instances.
- The in-process maintenance timer is replaced by a cron trigger
  (`*/30 * * * *` in `wrangler.jsonc`) → `scheduled()` → DO maintenance
  endpoint. `AKENTROS_MAINTENANCE_INTERVAL_MS` does not apply on Workers.
- Schema migrations + admin seed run automatically inside the DO before the
  first request (same code path as `npm run migrate`,
  `src/utils/bootstrap.ts`); `npm run migrate` is Node-only and not needed.

Deploy:

```bash
cd apps/gateway
npx wrangler login
npx wrangler secret put JWT_SECRET            # openssl rand -hex 32
npx wrangler secret put AKENTROS_API_KEY_PEPPER # openssl rand -hex 32
npx wrangler secret put ADMIN_EMAIL           # optional admin seed
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put OPENROUTER_API_KEY_1  # only providers actually enabled
# set FRONTEND_ORIGINS / FRONTEND_BASE_URL in wrangler.jsonc "vars" first
npx wrangler deploy
```

Smoke test (same as section 3, against `https://<worker>.workers.dev`), plus
`POST /api/auth/login` to confirm the admin seed. The `/internal/maintenance`
path is rejected at the Worker edge (404); cron reaches it only through the
DO binding.

Workers-specific caveats:

- DO storage is replicated by Cloudflare; the single-file `.backup` strategy
  in section 5 does not apply. Verify restore/DR expectations separately.
- SQL parameter bindings accept only `number | string | ArrayBuffer | null`
  (no BigInt) and row values surface as `number` for integer columns.
- The `console` (React + Vite static build) deploys to Cloudflare Pages:
  build command `npm run build --workspace @akentros/console`, output
  directory `apps/console/dist`, `VITE_AKENTROS_API_BASE` pointing at the
  Worker URL; set `FRONTEND_ORIGINS` on the Worker to the Pages origin.
  SPA fallback (`apps/console/public/_redirects`) is included in the build.

## 1. Required configuration

The gateway uses one SQLite database file (Topology A) or the DO's built-in
SQLite storage (Topology B), one session secret and one API-key pepper.
Configure these in the environment (`.dev.vars` for local, real env vars for
production, `wrangler secret put` on Workers):

- `AKENTROS_DB_PATH` - SQLite file path (default `./akentros.db`, relative to
  `apps/gateway/`)
- `JWT_SECRET` (at least 32 random bytes; signs the console session cookie)
- `AKENTROS_API_KEY_PEPPER` (at least 32 random bytes)
- `AKENTROS_ENABLED=true` - fail-closed gate for `/api/ai/*`
- `FRONTEND_ORIGINS` - cookie-enabled console origins (CSV)
- Provider upstream keys - set only the providers actually enabled (see
  [PROVIDERS.md](PROVIDERS.md)); secrets live only in the runtime environment,
  the database stores opaque credential IDs.

## 2. Migrations

Migrations are versioned in `packages/core/src/schemaMigration.ts` (SQLite
dialect; the version history resets at v1 for the SQLite engine):

```bash
npm run migrate    # applies pending migrations, seeds the admin account
```

The migration runner is idempotent; it records each applied version in
`akentros_ai_schema_migrations` and refuses to serve (fail-closed readiness
check in `aiSchema.ts`) until the recorded version matches
`AKENTROS_SCHEMA_VERSION`.

## 3. Smoke test after deploy

```bash
curl -s http://127.0.0.1:8787/api/ai/v1/models -H "Authorization: Bearer sk-akentros-live_invalid"
# expect: 401 authentication_error (proves the inference face + auth + DB read)

# Anti-enumeration probe (registration is enabled): signing up twice with the
# same email must return 201 (fresh, session issued) then 202 {"ok":true}
# (duplicate, NO session, NO email_taken code):
curl -s -w '\n%{http_code}\n' -X POST http://127.0.0.1:8787/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"probe@example.com","username":"probe","password":"probe-pass-1"}'
# expect: 201 {"user":{...}} then, on repeat, 202 {"ok":true,"message":"Registration accepted..."}
```

Then create a key in the console and run one streaming request; verify in the
console request log that the request settles (charged > 0) or refunds
(provider failure) - never stays `reserved`.

## 4. Reconciliation

The in-process maintenance loop refunds reservations that expire without a
provider dispatch and resolves quarantined reservations after their window.
To run it manually (for example from cron on an external scheduler):

```bash
node apps/gateway/scripts/reconcileAkentros.ts
```

## 5. Backup and restore

The database is a single SQLite file. Use the online backup API so you never
copy a mid-write file:

```bash
sqlite3 "$AKENTROS_DB_PATH" ".backup '/backups/akentros-$(date +%F).db'"
```

Restore = stop the gateway, replace the file, start the gateway. Do not copy
the `-wal` / `-shm` files alone; the `.backup` approach handles them
correctly.

## 6. Rollback

Roll back the code, not the schema. Schema migrations only move forward
(`schemaMigration.ts`); a code rollback to an older gateway version is safe
because the readiness check fails closed when the recorded schema is newer
than the code supports - in that case restore the matching database backup
from section 5 together with the code.

If a gate fails:

1. Set `AKENTROS_ENABLED` away from `true` (fail-closed) or block the route at
   the traffic layer.
2. Stop new provider dispatches; keep read-only logs available to operators.
3. Do not reverse schema migrations while AI request or ledger rows exist.
4. Let active requests finish or expire, then run reconciliation.
5. Rotate any provider or Akentros credential that may have been exposed.
6. Restore application code only after confirming ledger invariants.

Database rollback is restore-forward: repair with a new versioned migration or a
verified backup restore, never with ad-hoc destructive DDL.
