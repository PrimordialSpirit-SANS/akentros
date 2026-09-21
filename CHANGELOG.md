# Changelog

All notable changes to Akentros Gateway are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [SemVer](https://semver.org/).

## [Unreleased]

### Added

- **OpenAI-compatible embeddings endpoint.** `POST /api/ai/v1/embeddings`
  serves text embeddings for models whose pricing capabilities declare
  `embeddings` (new catalog entries `akentros/text-embedding-3-small` at
  $0.02/M input tokens and `akentros/text-embedding-3-large` at $0.13/M,
  routed through the openai pool). The endpoint reuses the chat pipeline
  verbatim — key auth, model allowlist, RPM/in-flight admission, the
  reserve→settle→refund ledger, provider attempt auditing and
  `Idempotency-Key` — with input-only billing: reservations are computed with
  zero output tokens, provider usage carries `prompt_tokens`/`total_tokens`
  only, and the minimum charge still applies. Requests accept a string or up
  to 2048 strings plus optional `dimensions`/`encoding_format`; chat models
  reject the embeddings endpoint and embedding models reject
  chat/completions. New API keys are granted the `embeddings` scope by
  default; existing keys with `chat:completions` keep working on the endpoint
  (backward-compatible scope check). Pricing revision `2026-09-19.1` also
  syncs the console's static model/provider catalogs.
- **Opt-in idempotent replay (OpenAI-compatible semantics).** API keys can now
  enable `idempotency_replay_ttl_seconds` (0-604800 seconds, default 0) at
  creation time. With a window greater than zero, successful responses — both
  JSON and full SSE frame sequences — are stored in the new
  `ai_idempotency_replays` table (schema v3) keyed by
  `(api_key_id, idempotency_key)`, and retrying a completed key with an
  identical request body replays the stored response (`200` +
  `X-Akentros-Idempotent-Replay: true`) without a second execution, a second
  charge, or RPM/in-flight admission. A body mismatch under the same key
  returns `409 idempotency_conflict`, matching the reservation fingerprint
  check. Keys without the opt-in keep the default no-storage stance
  (`409 idempotent_request_replayed`), so prompts/completions are still never
  persisted unless a deployment explicitly chooses it per key. Replays are
  capped at 2 MB (larger responses skip storage silently), expired rows are
  purged by the maintenance loop (`expiredReplays` counter), and replay
  responses are served before admission so they cannot consume rate limit
  budget. Every replay hit also writes a lightweight `status='replayed'`
  request-log row (zero tokens, zero cost, `replay_of_request_id` pointing at
  the original request) so replays stay visible in the developer console and
  usage API; the console key form gained a matching 冪等重放 field and the
  request log a 重放 status label/filter. Requires `npm run migrate`
  (schema v3).
- **Prometheus metrics on the Node deployment.** `GET /metrics` (Node
  self-hosted topology only; not mounted on Workers, where in-process
  counters would be meaningless) exposes request counters by endpoint and
  HTTP status, request duration sums/counts, settled token usage by
  direction, settled spend in micro-USD, plus `akentros_up`,
  `akentros_process_uptime_seconds` and a live `akentros_db_up` probe. Set
  `AKENTROS_METRICS_ENABLED=false` to opt out. The metrics module uses no
  Node-specific APIs and no dependencies; Workers imports remain inert.

### Fixed

- **Refund ledger entries recorded a shifted running balance.** The settle
  and refund paths computed the refund entry's `balance_before` as
  `read_balance − refunded` and wrote `balance_after` as the pre-update read,
  so every refund entry understated both columns by exactly the refund amount
  and the ledger chain diverged permanently from `users.balance` (a reserve of
  8 µUSD settled at 3 with a 5 µUSD refund recorded `999987 → 999992` while
  the real balance was `999997`). The ledger is the reconciliation surface, so
  every audit query would have disagreed with the account table by one refund
  per request. Both entries now record `before = read_value`,
  `after = read_value + refunded` (BigInt-exact), with a regression test pinning
  the full chain against the live `users.balance`.
- **The zero-cost settle guard was dead code.** The settle UPDATE's
  `AND (? > 0 OR reserved_usd_micros = 0)` guard bound `actualCostMicros` as a
  decimal TEXT string; SQLite's cross-type ordering places TEXT above INTEGER,
  so the guard compared true on every request and a non-zero reservation with
  a reported cost of 0 settled successfully (full silent refund) instead of
  being rejected as a data anomaly. The parameter is now `CAST` to BIGINT like
  its sibling in the same statement (the very trap the clamp was already
  casting around), turning the guard live; a zero-reservation request keeps
  its dedicated reserved-zero path, and a regression test pins
  `actual = 0 ∧ reserved > 0 ⇒ 409 invalid_billing_state` with the reservation
  left intact for reconciliation.
- **Unauthenticated and authenticated request bodies were buffered without
  any size limit.** `c.req.json()` on `/api/auth/*` (rate-limited to 60/15 min
  per IP but otherwise anonymous) and `/api/ai/v1/chat/completions` buffered
  the entire body into memory before any validation, and the developer
  console's `readJsonObject` read the full text before checking its 16 KB cap;
  with key-level RPM up to 6,000/min a valid key could amplify memory pressure
  arbitrarily. All three entry points now read bodies through a shared capped
  reader (Content-Length pre-check plus per-chunk hard cap: 32 MB on the
  public inference surface, 16 KB on auth and developer endpoints), the
  oversized public error is returned as a documented `413
  request_too_large`, and defense-in-depth caps were added inside request
  validation (`tool_calls[].function.arguments` ≤ 256 K chars,
  `tools[].function.parameters` ≤ 64 K serialized chars). Contract test
  updated to the dialect-neutral `is_active = 1` pin.
- **The developer console font stack referenced a font that does not exist.**
  The rebrand renamed `"Noto Sans TC"` to `"Noto Akentros TC"` and the generic
  `sans-serif` fallback to an invalid `akentros-serif`, so every client fell
  through to arbitrary system fonts. The real font names are restored.
- **Hono apps were rebuilt per request on the Durable Object path.** The
  earlier fix hoisted `createApp(env)` out of the per-request fetch on Node;
  the DO entry point still rebuilt the app (route registration, middleware
  assembly) on every request. The DO now builds its app once in the
  constructor.
- **The IP rate limiter's database path never activated on default
  deployments.** The middleware gated the database counter on
  `DATABASE_URL` being set, but the documented Node setup configures
  `AKENTROS_DB_PATH` (no `DATABASE_URL`), and Workers deployments never set it
  — so the documented "SQLite fixed-window limiter (global)" silently ran
  per-isolate in memory and reset on eviction. The limiter now always tries
  the installed adapter (node:sqlite, DO storage.sql, or PostgreSQL) and only
  falls back to the in-memory window when the database is unavailable, with
  the same fail-open behavior and warn log as before.

### Added

- **PostgreSQL is now a supported Node self-hosting database alongside
  SQLite.** The core stores were already dialect-aware; this release
  completes the port: versioned migrations and readiness checks carry a
  `postgres` dialect (BIGINT identity primary keys, `to_char(now() AT TIME
  ZONE 'UTC', …)` timestamp defaults, `information_schema`/`pg_indexes`
  catalog checks), timestamps remain UTC ISO-8601 TEXT strings so every
  string-comparison invariant is unchanged, and booleans stay INTEGER 1/0. A
  new `db.pg.ts` adapter (pg Pool, `?` → `$n` placeholder conversion,
  ALS-bound transactions) is installed automatically when `DATABASE_URL` is a
  `postgres://` URL. Money paths add the serialization SQLite got for free
  from its single-writer lock: `FOR UPDATE` row locks on the balance/spend
  rows read by reserve/settle/refund, and per-entity `pg_advisory_xact_lock`
  serialization for provider-pool claims and key RPM/in-flight admission.
  Six end-to-end tests on an embedded PostgreSQL (pglite) pin migration
  idempotency, the billing ledger chain, the zero-cost guard, idempotency
  replay, provider pool claim/release with health backoff, and admission
  control.
- react-router-dom was upgraded to ^7.18.4, clearing the two React Router
  moderate advisories (open redirect via backslash in `Link`/`useNavigate`
  and SSR `deserializeErrors()` constructor injection). The remaining two
  `@vitest/mocker` moderates are dev-only (no production surface) and await
  the vitest 5 major.

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
  each request env (`AKENTROS_REMOTE_ADDR`) and the limiter uses it as the
  identity; the header is only honored when `AKENTROS_TRUST_PROXY=true`
  explicitly opts into a trusted reverse proxy. Cloudflare Workers/Durable
  Object deployments (where every request transits Cloudflare and the runtime
  cannot expose the socket address) keep using the header. Unit tests pin the
  full decision table.
- **Node SQLite adapter did not serialize transactions.**
  `withAkentrosTransaction` executed `BEGIN IMMEDIATE` immediately; two
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

- **`AKENTROS_DB_PATH` was resolved against `process.cwd()`, so `npm run
  migrate` and `npm run dev:gateway` opened different databases.** `migrate`
  is a workspace script (cwd `apps/gateway/`) while `dev:gateway` /
  `start:gateway` run from the repo root; with the documented default
  `./akentros.db` the schema landed in `apps/gateway/akentros.db` but the server
  opened a fresh, empty `akentros.db` at the repo root, and the first request
  failed with `500 no such table: users`. Relative paths — including the
  `sqlite://` / `file:` forms — now anchor to the gateway package directory
  regardless of cwd; absolute paths and `:memory:` keep their literal
  meaning. In passing, the `file:` prefix strip no longer eats the root
  slash of `file:///abs/path` (which previously degraded absolute paths to
  package-relative ones). Regression tests pin cwd-invariance from both the
  repo root and `apps/gateway/`.
- **Same-UTC-day API key expiry bypass.** `authenticateAkentrosApiKey` compared
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
  `AkentrosApiKeyAuthRow` interface so reading a column outside the SELECT is a
  compile-time error.
- **README documented a `AKENTROS_SIGNUP_BONUS_POINTS` environment variable**
  that does not exist; the row was removed.

### Added

- **`AKENTROS_TRUST_PROXY` configuration.** Opt-in flag (see Fixed above and
  `apps/gateway/.dev.vars.example`) controlling whether the auth rate limiter
  trusts the `cf-connecting-ip` header on Node self-hosted deployments behind
  a reverse proxy that overwrites it. Default (unset) uses the socket remote
  address; the Cloudflare Workers deployment is unaffected and always uses
  the header.
- **`GET /healthz` liveness/readiness probe.** Reports `200 ok` or
  `503 degraded` (with `database: ok|unavailable`) based on a `SELECT 1`
  probe through the installed DB adapter. The endpoint sits outside the
  `AKENTROS_ENABLED` fail-closed gate and sends `Cache-Control: no-store`, so
  load balancers can distinguish "alive but not ready" even before the
  gateway is enabled. Covered by a gateway surface test (degraded path via
  the missing adapter, ok path via a fake adapter).
- **Structured JSON logging.** New `src/utils/logger.ts`
  (`logAkentrosEvent(level, event, fields)`) emits one JSON line per event
  (`time`, `level`, `event`, plus event metadata) on both runtimes; all
  free-text `console.error` call sites (gateway onError, key auth, key
  management, usage queries, rate-limit degradation, scheduled maintenance)
  were switched over. Only event metadata is logged — the no-prompts /
  no-keys rule from the security model is unchanged.
- **Opt-in provider smoke test** (`apps/gateway/tests/providerSmoke.test.ts`).
  Skipped by default so local runs and CI are unaffected; with
  `AKENTROS_SMOKE_TEST=1` (plus `AKENTROS_SMOKE_PROVIDER` / `AKENTROS_SMOKE_MODEL`
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
  replays the original response for a completed idempotency key; Akentros
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
  from `AKENTROS_PASSWORD_ITERATIONS` instead of a hardcoded `25000` literal,
  keeping both login paths equally expensive, and `verifyPassword` rejects
  iteration counts below the 10,000 floor the hasher already enforced.
  Cloudflare Workers free-plan CPU limits may require lowering
  `AKENTROS_PBKDF2_ITERATIONS` on that topology (documented in
  `.dev.vars.example`).
- **The core billing/provider-pool/attempt interfaces are fully typed.** New
  `packages/core/src/query.ts` defines the DB query contract
  (`AkentrosQuery`/`AkentrosQueryResult`) shared by the node:sqlite and Durable
  Object adapters; `billing.ts` exports `AkentrosBillingStore`,
  `AkentrosBillableBilling` (the runtime-consumed subset), typed
  reserve/settle/refund inputs and `AkentrosBillingRow`; `providerPool.ts`
  exports `AkentrosCredentialClaim`/`AkentrosProviderPoolClaimStore`;
  `providerAttempts.ts` exports `AkentrosAttemptAuditor`;
  `inference.ts`'s `createAkentrosInferenceRuntime` now takes
  `AkentrosInferenceRuntimeOptions` instead of `any`. The gateway side
  (`aiBilling.ts`, `aiProviderPool.ts`, `aiProviderAttempts.ts`,
  `createAkentrosQuery`) and its runtime wiring lost their `any` annotations;
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
  shared `AkentrosEnv` (Bindings: `AkentrosRuntimeEnv`; Variables: `user`,
  `aiKey`, `aiUser`, `aiRequestId`) plus `AkentrosAuthenticatedKey`; all
  middleware, routes and handlers now use `AkentrosContext`/`AkentrosNext`
  instead of `(c: any, next: any)`, `sendOpenAiError` takes `unknown` errors,
  `authenticateAkentrosApiKey`/`ensureAkentrosSessionCredential` have explicit
  return types, and `env` parameters across gateway utils are typed as
  `AkentrosRuntimeEnv`. Remaining `any`s are limited to the deliberate
  boundary to `@akentros/core`'s untyped inference-runtime factory.
- Removed the unused `distributed` option from `createRateLimit` (dead code;
  the DB path is selected by `DATABASE_URL` presence) and its one vestigial
  caller flag.
- `z-ai.svg`: dropped the deprecated Illustrator `enable-background` style
  attribute (flagged as an error by Biome's `noUnknownProperty`).

### Changed

- **Gateway imports `@akentros/core` through the workspace package boundary.**
  All 19 gateway source/script/test files previously reached into
  `packages/core/src/*` via four-level relative paths; they now import
  subpaths (`@akentros/core/billing`, `@akentros/core/pricing`, …) declared in a
  new `exports` map in `packages/core/package.json`, with `@akentros/core`
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
  akentros/providers/` now bundles each provider's official mark (downloaded
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
  - `AKENTROS_DB_PATH` replaces `DATABASE_URL`/`POSTGRES_DB_URL`.
- Core behavioral tests upgraded from fake query mocks to a real in-memory
  SQLite database (`packages/core/tests/sqliteTestDb.ts`).

### Added

- Gateway-layer test suite (auth session, CSRF double-submit, fail-closed gate,
  input validation, rate-limit fallback paths) running under `node --test`.
- Distributed rate limiting for auth and key-management endpoints: fixed-window
  counters stored in PostgreSQL (`akentros_ip_rate_limit_windows`), effective across
  Worker isolates, with an in-isolate memory limiter as degraded fallback.
- Biome lint/format toolchain (`npm run lint`), enforced in CI.
- `npm audit` dependency check in CI; Dependabot for npm actions/updates.

- Schema migration v7 (`akentros_ip_rate_limit_windows`): the IP rate-limit table
  is created through the versioned migration instead of ad-hoc DDL, per the
  "schema only moves forward" rule in CONTRIBUTING.md.

### Changed

- README rate-limit documentation now matches the actual enforcement semantics.
- Console a11y findings tracked as lint warnings (10 known, see `biome.json`).

### Security

- **The Node gateway now binds to loopback by default.** `nodeServer.ts`
  previously accepted connections on every interface (`0.0.0.0`), silently
  exposing a freshly started self-hosted deployment to the whole network —
  including the unauthenticated `/healthz`, CORS preflight handling and the
  auth endpoints — before any firewall or reverse proxy had been configured.
  The server now binds to `127.0.0.1` unless `AKENTROS_HOST` (or `HOST`) is
  set explicitly; containerized or proxied deployments that need external
  reachability set `AKENTROS_HOST=0.0.0.0` themselves and own access control
  in front of the process. The `akentros_gateway_listening` log line now also
  records the bound address so operators can verify it.
- **Signup no longer doubles as an account-enumeration oracle.**
  `POST /api/auth/register` used to answer a duplicate email with
  `409 email_taken` and short-circuited before the password hash, so an
  unauthenticated attacker could both read existence straight from the
  response and infer it from the missing PBKDF2 cost. Registration now (1)
  always hashes the password before touching the database, equalizing
  response timing with the login endpoint's dummy-hash technique, and
  (2) answers duplicate emails with an indistinct `202 {"ok": true}` accepted
  response — no session cookie, no user object, no `email_taken` code — with
  the duplicate concealed behind a `akentros_signup_duplicate_concealed` warn
  log for operator visibility. Console registration handles the
  session-less 202 by guiding the user to the login form. Private,
  internal-only deployments can restore the explicit `409 email_taken`
  contract with `AKENTROS_SIGNUP_ANTI_ENUMERATION=false`; public deployments
  should additionally consider `AKENTROS_DISABLE_REGISTRATION=true`.
- **Dev dependency audit is clean again.** `vitest` is bumped from
  `^3.2.4` to `^4.1.11` in `apps/console`, clearing the moderate-severity
  path traversal in `@vitest/mocker` (GHSA-82fw-gwwq-j7x9, `npm audit`
  2 moderate → 0). The advisory is dev-only (test-time mock resolution), but
  the fix keeps `npm audit` a usable CI gate.
