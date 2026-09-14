# Changelog

All notable changes to Beacon Gateway are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [SemVer](https://semver.org/).

## [Unreleased]

### Fixed

- **Same-UTC-day API key expiry bypass.** `authenticateBeaconApiKey` compared
  `expires_at` (stored as UTC ISO-8601 text, e.g. `2026-09-15T10:00:00.000Z`)
  against SQLite `CURRENT_TIMESTAMP` (rendered with a space separator,
  `2026-09-15 10:00:00`). Lexicographically `T` > ` `, so a key expiring
  earlier on the current UTC day was treated as valid for the whole day. The
  comparison now binds a same-format ISO `now` parameter (matching the billing
  path). Regression tests pin the expired-same-day, expired-prior-day,
  unexpired and create/round-trip paths.
- **Phantom `points` field on authenticated keys.** The key-authentication
  SELECT never returned a `points` column (the users table has no such
  column; the billing ledger is USD-only), so `key.user.points` was always
  `NaN`. The field is removed, and the SELECT result is now typed by a
  `BeaconApiKeyAuthRow` interface so reading a column outside the SELECT is a
  compile-time error.
- **README documented a `BEACON_SIGNUP_BONUS_POINTS` environment variable**
  that does not exist; the row was removed.

### Added

- Behavior tests for `reconcileStale`: stale reservations that already
  dispatched are quarantined (`needs_reconciliation`, balance untouched,
  awaiting the `resolveQuarantined` refund exit), while never-dispatched
  reservations are refunded in full (`reservation_expired`, 504, ledger
  credit). Previously only the stale-row SQL was covered.

### Changed

- **The gateway's Hono layer is fully typed.** New `src/types.ts` defines the
  shared `BeaconEnv` (Bindings: `BeaconRuntimeEnv`; Variables: `user`,
  `aiKey`, `aiUser`, `aiRequestId`) plus `BeaconAuthenticatedKey`; all
  middleware, routes and handlers now use `BeaconContext`/`BeaconNext`
  instead of `(c: any, next: any)`, `sendOpenAiError` takes `unknown` errors,
  `authenticateBeaconApiKey`/`ensureBeaconSessionCredential` have explicit
  return types, and `env` parameters across gateway utils are typed as
  `BeaconRuntimeEnv`. Remaining `any`s are limited to the deliberate
  boundary to `@beacon/core`'s untyped inference-runtime factory.
- Removed the unused `distributed` option from `createRateLimit` (dead code;
  the DB path is selected by `DATABASE_URL` presence) and its one vestigial
  caller flag.
- `z-ai.svg`: dropped the deprecated Illustrator `enable-background` style
  attribute (flagged as an error by Biome's `noUnknownProperty`).

### Changed

- **Gateway imports `@beacon/core` through the workspace package boundary.**
  All 19 gateway source/script/test files previously reached into
  `packages/core/src/*` via four-level relative paths; they now import
  subpaths (`@beacon/core/billing`, `@beacon/core/pricing`, …) declared in a
  new `exports` map in `packages/core/package.json`, with `@beacon/core`
  added to the gateway's dependencies. The core boundary is now enforced by
  module resolution instead of convention. Behavior is unchanged; both the
  Node server and the Workers bundle resolve identically.
- **Removed the `POSTGRES_DB_URL` vestige.** Store-cache key helpers
  (`aiBilling`, `aiLimits`, `aiProviderAttempts`, `aiProviderPool`,
  `aiSchema`, `aiUsage`, `rateLimit`) accepted a `POSTGRES_DB_URL` alias
  left over from the PostgreSQL era; they now key off `DATABASE_URL` alone,
  and the stale "PostgreSQL fixed-window" comments in `rateLimit.ts` now
  describe the actual SQLite behavior.
- **Model catalog reorganized to the eight-family sample library (pricing
  revision `2026-09-14.1`).** The console catalog and gateway pricing now
  expose 19 current-generation models across GPT, Claude, Gemini, Grok,
  DeepSeek, Kimi, GLM and Qwen: GPT-6 Astra / GPT-5.2 / GPT-5.2 Codex,
  Claude Opus 4.8 / Sonnet 5 / Haiku 4.5, Gemini 3.5 Pro / 3.8 Flash /
  3.5 Flash-Lite, Grok 4.6 / 4.1 Fast, DeepSeek V4 Pro / V4.1 Flash,
  Kimi K3, GLM-5.3 / 5.3 Flash, Qwen 3.8 Max / Flash / 27B. The retired
  2025-era entries (Llama, Gemma, GPT-OSS, Mistral, Sonar, Command,
  MiniMax, Gemini 2.5, Grok 4.x, DeepSeek V3.2, Kimi K2, GLM-5.2) were
  removed from the catalogs and their tests/fixtures updated to match.
- **Official brand icons shipped locally.** `apps/console/public/brand/
  beacon/providers/` now bundles each provider's official mark (downloaded
  from official sites / Wikimedia Commons: OpenAI blossom, Claude starburst,
  Gemini sparkle, xAI, DeepSeek whale, Kimi K, Z.ai, Qwen, Cloudflare), the
  manifest points `display_asset_url` at the local files instead of showing
  letter badges, and unused provider placeholder SVGs were removed. See
  `docs/BRAND_ASSETS.md` for sources and trademark attribution.

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
