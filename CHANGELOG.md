# Changelog

All notable changes to Beacon Gateway are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [SemVer](https://semver.org/).

## [Unreleased]

### Added

- **Cloudflare Workers deployment (Topology B).** The gateway now runs on
  Cloudflare Workers with the entire Hono app + SQLite inside a single
  SQLite-backed Durable Object (`apps/gateway/src/worker.ts`,
  `src/worker/gatewayDo.ts`, `src/worker/doDb.ts`, `wrangler.jsonc`); the
  Node self-host server (Topology A) is unchanged and remains the reference.
  - DB access is behind a swappable adapter registry (`src/utils/db.ts`):
    Node keeps `node:sqlite` (`db.node.ts`); the DO uses `ctx.storage.sql`
    with `ctx.storage.transaction()` for multi-statement atomicity
    (equivalent semantics to `BEGIN IMMEDIATE` + queued queries). The
    single-writer invariant is preserved by the singleton DO instance
    (`idFromName`); do not shard it.
  - Schema migrations + admin seed run inside the DO before the first
    request, sharing `src/utils/bootstrap.ts` with the Node migrate script;
    the maintenance loop is shared (`src/utils/maintenance.ts`) and driven
    by a `*/30 * * * *` cron trigger on Workers.
  - Console deploys to Cloudflare Pages (SPA `_redirects` added).
  - Fixed in passing: `upsertAdminUser` issued an UPDATE with two
    placeholders but one binding (hit when re-running migrate against an
    existing admin).

### Changed (breaking)

- **Database engine switched from PostgreSQL to SQLite.** The gateway now runs
  as a plain Node server (Node >= 22.18, built-in `node:sqlite`) via
  `@hono/node-server`; no Docker/PostgreSQL/Cloudflare account required.
  - Billing, API-limit, provider-pool and attempt logic rewritten from
    single-statement data-modifying CTEs to explicit transactions
    (`BEGIN IMMEDIATE` ... `COMMIT`) with identical semantics.
  - Timestamps stored as UTC ISO-8601 TEXT (millisecond precision); booleans
    as 1/0; JSON columns as TEXT.
  - Schema migration history reset for the SQLite engine (v1 canonical schema,
    v2 IP rate-limit windows).
  - `docker-compose.yml` and the Cloudflare Worker entrypoint (`index.ts`,
    `wrangler.toml`) removed; new Node entrypoint `apps/gateway/src/nodeServer.ts`.
  - `BEACON_DB_PATH` replaces `DATABASE_URL`/`POSTGRES_DB_URL`.
- Core behavioral tests upgraded from fake query mocks to a real in-memory
  SQLite database (`packages/core/tests/sqliteTestDb.ts`).

### Added

- Gateway-layer test suite (auth session, CSRF double-submit, fail-closed gate,
  input validation, rate-limit fallback paths) running under `node --test`.
- Distributed rate limiting for auth and key-management endpoints: fixed-window
  counters stored in PostgreSQL (`beacon_ip_rate_limit_windows`), effective across
  Worker isolates, with an in-isolate memory limiter as degraded fallback.
- Biome lint/format toolchain (`npm run lint`), enforced in CI.
- `npm audit` dependency check in CI; Dependabot for npm actions/updates.

- Schema migration v7 (`beacon_ip_rate_limit_windows`): the IP rate-limit table
  is created through the versioned migration instead of ad-hoc DDL, per the
  "schema only moves forward" rule in CONTRIBUTING.md.

### Changed

- README rate-limit documentation now matches the actual enforcement semantics.
- Console a11y findings tracked as lint warnings (10 known, see `biome.json`).
