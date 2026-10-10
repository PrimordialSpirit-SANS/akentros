# Akentros deployment runbook

This runbook intentionally contains no credential values. Run every mutation
against an explicitly selected environment; never rely on an implicit shell
default when migrating or deploying Akentros.

## 0. Supported deployment topologies (read first)

Akentros supports three gateway topologies. All run the same Hono app and the
same versioned schema (SQLite dialect for A/B, PostgreSQL dialect for C); they
differ only in the database adapter and the maintenance scheduler.

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
- PostgreSQL on Workers is also supported via the **PG runtime** (see Topology
  C, "Cloudflare Workers" subsection): setting a `DATABASE_URL` secret or
  adding a `HYPERDRIVE` binding switches the entry off the Durable Object
  path; the default DO topology is unchanged otherwise.

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
  - SN-4 caveat: session cookies are `SameSite=Lax`, so a cross-site fetch
    from `*.pages.dev` to `*.workers.dev` (different sites under the public
    suffix list) never carries the cookie — the login response succeeds but
    every later management call returns 401. Pick exactly one:
    1. Host console and gateway under the same registrable domain
       (eTLD+1), e.g. `console.example.com` + `api.example.com`, with
       `VITE_AKENTROS_API_BASE=https://api.example.com/api`.
    2. Serve the console from Pages and proxy `/api/*` same-origin via
       Pages Functions or a reverse proxy, leaving
       `VITE_AKENTROS_API_BASE` empty (same-origin `/api`).
    3. (Not recommended) relax cookies to `SameSite=None; Secure` and
       re-evaluate the CSRF surface before doing so.
  - Same caveat applies to the local dev pairing of
    `http://127.0.0.1:8787/api` with the Vite dev server on
    `localhost:5173` (see `apps/console/vite.config.ts`).

### Topology C: Serverless platforms (PostgreSQL)

**Set `DATABASE_URL` to a `postgres://` connection string and the gateway
switches to PostgreSQL** — on any platform, from a long-lived VPS to
per-invocation functions. The engine is dialect-complete (BIGINT identity
keys, `FOR UPDATE` row locks, `pg_advisory_xact_lock` admission control), so
billing/limit invariants do not depend on SQLite's single-writer model. Pick
the driver per platform; `npm run migrate` auto-switches to the PG dialect.

Driver selection (`AKENTROS_PG_DRIVER=auto`, the default):

| Condition | Driver | Adapter |
| --- | --- | --- |
| Host is `*.neon.tech` | Neon-compatible WebSocket | `db.pg.serverless.ts` |
| `AKENTROS_PG_WS_PROXY` is set (self-hosted pg-gateway / supavisor) | Neon-compatible WebSocket | `db.pg.serverless.ts` |
| `HYPERDRIVE` binding present (Workers) | TCP `pg` via Hyperdrive | `db.pg.ts` |
| Everything else (VPS, Render, Vercel/Netlify Node functions) | TCP `pg` pool | `db.pg.ts` |

`AKENTROS_PG_DRIVER=pg-pool|neon` forces a driver (aliases: `pg`, `tcp`,
`neon-ws`, `serverless`); unknown values fail fast at startup. TLS is
inferred: remote hosts get `sslmode=require` semantics automatically (URL
`sslmode`/`ssl` params are honored; `AKENTROS_PG_SSL=disable|require|
verify-full` overrides), while loopback/private/unix-socket hosts stay
plaintext. Pool size defaults to 1 connection per instance on serverless
runtimes (Vercel, Netlify, Lambda, Workers isolates) and 10 on long-lived
processes; `AKENTROS_PG_POOL_MAX` overrides both.

Why a WebSocket driver: HTTP-only PG drivers batch whole transactions into one
request and cannot run Akentros's interactive money path (`SELECT … FOR UPDATE`
then decide then settle). The Neon-compatible driver runs a genuine
interactive PG session over WebSocket — `BEGIN`/`COMMIT`, row locks and
advisory locks all work statement-by-statement, identical to the TCP adapter.

**Vercel / Netlify (functions, Node or Edge runtime)**

1. Create a Neon project (or any PG behind a Neon-compatible WS gateway) and
   copy the **pooled** connection string (host containing `-pooler`) as
   `DATABASE_URL` — the `*.neon.tech` host auto-selects the WebSocket driver,
   which works in both Node and Edge functions.
2. Set `JWT_SECRET`, `AKENTROS_API_KEY_PEPPER`, `AKENTROS_ENABLED=true`,
   `FRONTEND_ORIGINS` and provider keys as environment variables.
3. Run migrations once from anywhere with DB network access (CI job or
   laptop): `npm run migrate`.
4. Run the gateway as a function wrapping `apps/gateway/src/nodeServer.ts`'s
   `createApp` pattern (or deploy the Node server in a container). Health:
   `GET /healthz`.

Non-Neon PG on functions (Supabase, RDS, self-hosted behind a gateway):
either use the platform's connection pooler over TCP (`pg-pool` driver, Node
runtime only) or put a pg-gateway/supavisor WebSocket proxy in front and set
`AKENTROS_PG_WS_PROXY` (works on Edge too).

**Render (persistent service)**

Render services are long-lived processes — the default TCP `pg` pool works
as-is. Point `DATABASE_URL` at Render Postgres (internal hostname stays
plaintext by the private-host rule; external hostnames get TLS automatically).
`npm run migrate` in the build or a one-off job, then start the Node server.

**Cloudflare Workers (PG runtime)**

Setting a `DATABASE_URL` secret **or** adding a Hyperdrive binding switches
`src/worker.ts` off the Durable Object: the Hono app runs directly on the
Worker with a PG adapter, and cron calls `runAkentrosMaintenance` without the
DO hop. Two connection modes:

- **Hyperdrive (recommended for TCP PG):** create a Hyperdrive binding and
  add it to `wrangler.jsonc`:

  ```jsonc
  "hyperdrive": [
    { "binding": "HYPERDRIVE", "id": "<hyperdrive-id>" }
  ]
  ```

  The binding's local channel replaces the connection string (TLS to origin
  is managed by Hyperdrive). `nodejs_compat` is already enabled.
- **Neon direct (no extra binding):** set `DATABASE_URL` to the Neon pooled
  string; the WebSocket driver connects over the native `WebSocket` API.

Migrations on the PG runtime run automatically before the first request per
isolate, serialized by a transaction-scoped advisory lock; you may still
pre-apply them with `npm run migrate` from Node. Notes: `/metrics` is
Node-topology-only (use Cloudflare observability); `/internal/maintenance`
stays edge-blocked and is reachable only via the cron trigger.

**Node.js VPS (Topology A with PostgreSQL)**

Unchanged from Topology A — just set `DATABASE_URL`. The TCP pool (default
max 10) is right for a long-lived process; TLS is automatic for remote hosts.

**Connection-budget guidance**

- Prefer pooled endpoints (Neon `-pooler`, Supabase pooler, RDS Proxy,
  PgBouncer in transaction mode) — serverless platforms multiply instances,
  and each instance holds a small pool (default 1 on functions).
- The `pg` driver's `pool.on("error")` is wired to structured logging; idle
  client disconnects (Neon suspend, provider restarts) no longer crash the
  process.
- Pools are cached on `globalThis`, so dev-server hot reloads and isolate
  reloads reuse connections instead of leaking them.

## 1. Required configuration

The gateway uses one SQLite database file (Topology A), the DO's built-in
SQLite storage (Topology B), or one PostgreSQL database (Topology C) — plus
one session secret and one API-key pepper. Configure these in the environment
(`.dev.vars` for local, real env vars for production, `wrangler secret put`
on Workers):

- `AKENTROS_DB_PATH` - SQLite file path (default `./akentros.db`, relative to
  `apps/gateway/`)
- `DATABASE_URL` - PostgreSQL connection string (Topology C); unset or
  non-`postgres://` means SQLite
- `AKENTROS_PG_DRIVER` / `AKENTROS_PG_SSL` / `AKENTROS_PG_WS_PROXY` /
  `AKENTROS_PG_WS_SECURE` / `AKENTROS_PG_POOL_MAX` - driver & connection
  tuning (Topology C; see section 0 / `.dev.vars.example`)
- `JWT_SECRET` (at least 32 random bytes; signs the console session cookie)
- `AKENTROS_API_KEY_PEPPER` (at least 32 random bytes)
- `AKENTROS_ENABLED=true` - fail-closed gate for `/api/ai/*` and `/api/auth/*`
- `FRONTEND_ORIGINS` - cookie-enabled console origins (CSV)
- `AKENTROS_METRICS_TOKEN` (Node topology only, SN-1) - protects `/metrics`
  (request counts, token spend) with `Authorization: Bearer <token>`; when
  unset, `/metrics` answers only loopback sources (127.0.0.1/::1) and returns
  404 to anyone else. Reverse-proxy deployments must set this token or block
  the `/metrics` path at the proxy.
- Provider upstream keys - set only the providers actually enabled (see
  [PROVIDERS.md](PROVIDERS.md)); secrets live only in the runtime environment,
  the database stores opaque credential IDs.

## 2. Migrations

Migrations are versioned in `packages/core/src/schemaMigration.ts` (SQLite
dialect; the version history resets at v1 for the SQLite engine):

- v1 — canonical runtime schema; v2 — distributed IP rate-limit windows;
  v3 — idempotent replay store; v4 — `users.session_epoch` for
  server-side session revocation (SEC-01).

```bash
npm run migrate    # applies pending migrations, seeds the admin account
```

The migration runner is idempotent; it records each applied version in
`akentros_ai_schema_migrations` and refuses to serve (fail-closed readiness
check in `aiSchema.ts`) until the recorded version matches
`AKENTROS_SCHEMA_VERSION`. With `DATABASE_URL` set, the same command applies
the PostgreSQL dialect (the version history is recorded per engine). On the
Workers PG runtime, migrations run automatically before the first request
per isolate, serialized by a transaction-scoped advisory lock — pre-running
`npm run migrate` from Node is still the recommended release step. v4 adds
`users.session_epoch` (default 0); tokens issued before the upgrade carry no
`epv` claim and are treated as epoch 0, so existing console sessions survive
the upgrade.

### Session revocation (SEC-01)

The console session cookie is a 7-day stateless JWT; logout only deletes the
browser cookie. `users.session_epoch` (schema v4) is the server-side kill
switch: every issued token binds the account's current epoch in the fixed
`epv` claim, and `authenticateToken` rejects the token with
`401 session_revoked` once the epochs diverge — without rotating
`JWT_SECRET` (which would log out every user at once).

```bash
# From the repo root (same pattern as section 4's reconcile script):
node apps/gateway/scripts/revokeAkentrosSessions.ts --all                 # every account (global incident response)
node apps/gateway/scripts/revokeAkentrosSessions.ts --id 42               # one account by id
node apps/gateway/scripts/revokeAkentrosSessions.ts --email user@example.com   # one account by email

# Or from apps/gateway/ (flags forward cleanly from the workspace directly):
npm run revoke:sessions -- --all
```

The script reads the same `.dev.vars` / `DATABASE_URL` environment as
`npm run migrate` (paths are anchored to `apps/gateway`, so any cwd works) and
applies the v4 migration idempotently first. Affected users simply sign
in again and receive a session on the new epoch. The same hook is where a
future change-password or admin block flow should revoke sessions. Note:
prefer the direct `node` invocations above when scripting — routing flags
through the root-level `npm run revoke-sessions -- …` alias drops them (npm
consumes `--email` and friends as its own config while forwarding to the
workspace). On the
Workers Durable Object topology, run the equivalent SQL directly against the
DO's SQLite:

```sql
UPDATE users SET session_epoch = session_epoch + 1;  -- all accounts
UPDATE users SET session_epoch = session_epoch + 1 WHERE email = 'user@example.com';
```

### Rate-limit window boundary (SEC-03, documented, accepted)

Login/registration rate limiting uses a fixed-window counter (60 attempts per
15 minutes per identity, by default). Known boundary of that design: a single
identity can pass up to `2 × max` requests within seconds when the requests
straddle a window boundary. The brute-force defense target is therefore
"≤ 2 × max attempts per window"; with the 8-character password minimum and
PBKDF2-SHA256 at 600k iterations, this does not weaken the defense target.
Eliminating it would require a sliding-window store (multi-row
`identity × window_start` upserts plus a new forward-only migration); the
cost is judged disproportionate to the risk. See the header of
`apps/gateway/src/middleware/rateLimit.ts`.

## 3. Smoke test after deploy

```bash
curl -s http://127.0.0.1:8787/api/ai/v1/models -H "Authorization: Bearer sk-akentros-live_invalid"
# expect: 401 authentication_error (proves the inference face + auth + DB read)

# Anti-enumeration probe (registration is enabled): signing up twice with the
# same email must return the SAME indistinguishable 202 {"ok":true} both
# times — no user payload, no session cookie, no email_taken code:
curl -s -w '\n%{http_code}\n' -X POST http://127.0.0.1:8787/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"probe@example.com","username":"probe","password":"probe-pass-1"}'
# expect: 202 {"ok":true,"message":"Registration accepted..."} then, on repeat,
# the byte-identical 202 response (fresh signups no longer auto-login; the
# account is immediately usable via the normal login endpoint)
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
