# Changelog

All notable changes to Beacon Gateway are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [SemVer](https://semver.org/).

## [Unreleased]

### Fixed

- **Settlement did not cap the charge at the reserved amount.** The `settle`
  SQL wrote `charged_usd_micros = ?` and `refunded_usd_micros = reserved - ?`
  directly from the provider-reported actual cost, so a malicious or buggy
  upstream that inflated usage could charge past the pre-authorized reservation,
  producing negative refunds and pushing user balances below what the
  reservation authorized (a reserve of 1,000 µUSD settled with an actual cost
  of 9,000 µUSD charged 9,000 and recorded a refund of −8,000). The SQL now
  clamps with `MIN(CAST(? AS INTEGER), reserved_usd_micros)` — the parameter
  must be CAST because micro-USD values bind as decimal strings (TEXT) and
  SQLite scalar functions do not apply column affinity, so an un-cast
  comparison would clamp to the wrong side; `LEAST()` is unavailable in the
  `node:sqlite` build (no `SQLITE_ENABLE_MATH_FUNCTIONS`). A regression test
  pins `actual > reserved` ⇒ `charged == reserved`, no negative refund, no
  refund ledger entry, and the balance debited exactly the reservation.
- **Node self-hosted auth rate limiting could be bypassed with a forged
  `cf-connecting-ip` header.** The login/register limiter keyed on the
  request header, which is only trustworthy behind Cloudflare; on a Node
  deployment an attacker could send a different fake IP per request to defeat
  the 60/15 min limit entirely (unlimited password brute force and signup
  farming). The Node entry point now injects the socket remote address into
  each request env (`BEACON_REMOTE_ADDR`) and the limiter uses it as the
  identity; the header is only honored when `BEACON_TRUST_PROXY=true`
  explicitly opts into a trusted reverse proxy. Cloudflare Workers/Durable
  Object deployments (where every request transits Cloudflare and the runtime
  cannot expose the socket address) keep using the header. Unit tests pin the
  full decision table.
- **Node SQLite adapter did not serialize transactions.**
  `withBeaconTransaction` executed `BEGIN IMMEDIATE` immediately; two
  overlapping transactions would make the second throw `cannot start a
  transaction within a transaction` (surfacing as a 503). It worked only by
  the accident that every transaction body so far contains only synchronous
  DB calls. The adapter now chains transaction starts on a per-database
  promise chain, mirroring `worker/doDb.ts`'s `txChain`, so a future real-I/O
  `await` inside a transaction can no longer surface as random 503s under
  concurrency. Tests pin serialization and rollback-releases-chain.
- **Registration race returned 500 instead of 409.** Two concurrent signups
  with the same email both passed the `findUserByEmail` check; the second
  INSERT then hit `UNIQUE(users.email)` and fell through `onError` as a 500.
  The constraint violation is now caught and mapped to `409 email_taken`.
- **`tool_choice: "none"` was ignored for Anthropic.** It was mapped to
  `undefined` (Anthropic's default `auto`), so a caller explicitly requesting
  "no tool calls this turn" could still get tool calls. OpenAI's `"none"` now
  maps to `{"type": "none"}` (supported by the Anthropic Messages API); `tools`
  stay in the request because histories containing `tool_use`/`tool_result`
  blocks require them. Tests pin all four `tool_choice` mappings.
- **Every request rebuilt the entire Hono app.** The Node server constructed
  `createApp(env)` per request; the app is now created once outside `serve()`.
- **Shutdown could hang on open SSE streams.** `server.close()` only fires its
  callback after all connections end, so live inference streams blocked the
  shutdown flow indefinitely. Connections are now tracked; after a 3s grace
  they are destroyed, and a 10s hard timeout forces exit regardless.

- **`BEACON_DB_PATH` was resolved against `process.cwd()`, so `npm run
  migrate` and `npm run dev:gateway` opened different databases.** `migrate`
  is a workspace script (cwd `apps/gateway/`) while `dev:gateway` /
  `start:gateway` run from the repo root; with the documented default
  `./beacon.db` the schema landed in `apps/gateway/beacon.db` but the server
  opened a fresh, empty `beacon.db` at the repo root, and the first request
  failed with `500 no such table: users`. Relative paths — including the
  `sqlite://` / `file:` forms — now anchor to the gateway package directory
  regardless of cwd; absolute paths and `:memory:` keep their literal
  meaning. In passing, the `file:` prefix strip no longer eats the root
  slash of `file:///abs/path` (which previously degraded absolute paths to
  package-relative ones). Regression tests pin cwd-invariance from both the
  repo root and `apps/gateway/`.
- **Same-UTC-day API key expiry bypass.** `authenticateBeaconApiKey` compared
  `expires_at` (stored as UTC ISO-8601 text, e.g. `2026-09-15T10:00:00.000Z`)
  against SQLite `CURRENT_TIMESTAMP` (rendered with a space separator,
  `2026-09-15 10:00:00`). Lexicographically `T` > ` `, so a key expiring
  earlier on the current UTC day was treated as valid for the whole day. The
  comparison now binds a same-format ISO `now` parameter (matching the
  billing path). Regression tests pin the expired-same-day, expired-prior-day,
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

- **`BEACON_TRUST_PROXY` configuration.** Opt-in flag (see Fixed above and
  `apps/gateway/.dev.vars.example`) controlling whether the auth rate limiter
  trusts the `cf-connecting-ip` header on Node self-hosted deployments behind
  a reverse proxy that overwrites it. Default (unset) uses the socket remote
  address; the Cloudflare Workers deployment is unaffected and always uses
  the header.
- **`GET /healthz` liveness/readiness probe.** Reports `200 ok` or
  `503 degraded` (with `database: ok|unavailable`) based on a `SELECT 1`
  probe through the installed DB adapter. The endpoint sits outside the
  `BEACON_ENABLED` fail-closed gate and sends `Cache-Control: no-store`, so
  load balancers can distinguish "alive but not ready" even before the
  gateway is enabled. Covered by a gateway surface test (degraded path via
  the missing adapter, ok path via a fake adapter).
- **Structured JSON logging.** New `src/utils/logger.ts`
  (`logBeaconEvent(level, event, fields)`) emits one JSON line per event
  (`time`, `level`, `event`, plus event metadata) on both runtimes; all
  free-text `console.error` call sites (gateway onError, key auth, key
  management, usage queries, rate-limit degradation, scheduled maintenance)
  were switched over. Only event metadata is logged — the no-prompts /
  no-keys rule from the security model is unchanged.
- **Opt-in provider smoke test** (`apps/gateway/tests/providerSmoke.test.ts`).
  Skipped by default so local runs and CI are unaffected; with
  `BEACON_SMOKE_TEST=1` (plus `BEACON_SMOKE_PROVIDER` / `BEACON_SMOKE_MODEL`
  to narrow scope and the matching provider credentials) it sends a minimal
  live completion over an enabled route, asserting route enablement,
  credential resolution, a 200 upstream response and the usage source — the
  real-upstream integration face the unit/contract suites cannot cover.
- Behavior tests for `reconcileStale`: stale reservations that already
  dispatched are quarantined (`needs_reconciliation`, balance untouched,
  awaiting the `resolveQuarantined` refund exit), while never-dispatched
  reservations are refunded in full (`reservation_expired`, 504, ledger
  credit). Previously only the stale-row SQL was covered.

### Changed

- **Idempotency replay semantics are now documented explicitly.** OpenAI
  replays the original response for a completed idempotency key; Beacon
  (which never persists prompts/completions) returns
  `409 idempotent_request_replayed` with the original `X-Request-Id`, and
  `409 idempotent_request_in_progress` for keys still in flight. The README
  compatibility note, `docs/openapi.yaml` `Idempotency-Key` parameter, and the
  console docs page now call out the difference so replay-dependent clients
  are not surprised.
- **PBKDF2 password-hashing default raised from 25,000 to 600,000
  iterations** (OWASP Password Storage Cheat Sheet recommendation for
  PBKDF2-HMAC-SHA256). Old-format hashes still verify: the iteration count
  is stored inside the hash string, so no migration is needed. The
  timing-safe dummy hash used when an account does not exist now derives
  from `BEACON_PASSWORD_ITERATIONS` instead of a hardcoded `25000` literal,
  keeping both login paths equally expensive, and `verifyPassword` rejects
  iteration counts below the 10,000 floor the hasher already enforced.
  Cloudflare Workers free-plan CPU limits may require lowering
  `BEACON_PBKDF2_ITERATIONS` on that topology (documented in
  `.dev.vars.example`).
- **The core billing/provider-pool/attempt interfaces are fully typed.** New
  `packages/core/src/query.ts` defines the DB query contract
  (`BeaconQuery`/`BeaconQueryResult`) shared by the node:sqlite and Durable
  Object adapters; `billing.ts` exports `BeaconBillingStore`,
  `BeaconBillableBilling` (the runtime-consumed subset), typed
  reserve/settle/refund inputs and `BeaconBillingRow`; `providerPool.ts`
  exports `BeaconCredentialClaim`/`BeaconProviderPoolClaimStore`;
  `providerAttempts.ts` exports `BeaconAttemptAuditor`;
  `inference.ts`'s `createBeaconInferenceRuntime` now takes
  `BeaconInferenceRuntimeOptions` instead of `any`. The gateway side
  (`aiBilling.ts`, `aiProviderPool.ts`, `aiProviderAttempts.ts`,
  `createBeaconQuery`) and its runtime wiring lost their `any` annotations;
  a wrong field on a billing call is now a compile error instead of a
  runtime surprise. Test doubles were updated to the typed contracts.
- **All Biome a11y warnings fixed and the severity overrides removed.** The
  five `warn` downgrades in `biome.json` (`noSvgWithoutTitle`,
  `useAriaPropsSupportedByRole`, `useButtonType`, `useSemanticElements`,
  `noStaticElementInteractions`) are gone — these rules now fail CI at
  their default severity. Fixes: `role="group"` divs became semantic
  `<fieldset>` (key expiry / spend limit / auth mode pickers, with CSS
  resets), the log-detail backdrop became a real `<button>`, the code-tab
  buttons got `type="button"`, the brand-mark and modality badges declare
  `role="img"` for their `aria-label`s, a decorative `aria-label` on
  `<code>` became a `title`, and every brand SVG gained a `<title>`.
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
