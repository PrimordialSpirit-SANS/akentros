# @akentros/core

[![CI](https://github.com/PrimordialSpirit-SANS/akentros/actions/workflows/ci.yml/badge.svg)](https://github.com/PrimordialSpirit-SANS/akentros/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

The portable behavior core of the [Akentros Gateway](https://github.com/PrimordialSpirit-SANS/akentros) — a self-hosted, OpenAI-compatible AI gateway with USD-based billing and multi-provider pooling. This package contains everything that is deployment-agnostic and side-effect-light:

- **Pricing authority** — the versioned model catalog and micro-USD price tables (`config/backend-pricing.v1.json`), the single source of truth replicated by the gateway.
- **USD billing state machine** — reserve → settle → refund with integer micro-dollars, idempotent and replayable, with SQL parameterization invariants pinned by tests.
- **API keys** — `sk-akentros-*` key generation and HMAC-SHA256 (pepper) digests, expiry and allowlist validation.
- **Provider pools** — weighted routing, health state and cooldowns, in-flight leases, automatic failover across 37 credential slots.
- **Inference pipeline** — OpenAI-compatible request validation and mapping (including the Responses API bridge and vision message input).
- **SSE parsing** — the stream parser used on both the server and the client, hardened against BOM, CRLF splits and truncated terminal events.
- **Schema migrations** — versioned, forward-only SQLite/PostgreSQL schema evolution.

It deliberately does **not** contain an HTTP server, a database connection or any runtime secret: those live in [`apps/gateway`](https://github.com/PrimordialSpirit-SANS/akentros/tree/main/apps/gateway). The package has zero runtime dependencies.

## Install

```bash
npm install @akentros/core
```

Requires Node ≥ 20.19 (the emitted modules use JSON import attributes).

## Usage

Every module is a subpath export — import exactly what you need, tree-shaking discards the rest:

```ts
import { priceRequest } from "@akentros/core/pricing";
import { generateApiKey, digestApiKey } from "@akentros/core/apiKeys";
import { parseSseStream } from "@akentros/core/sse";
```

The full module list and the behavioral contract are documented in the
[monorepo README](https://github.com/PrimordialSpirit-SANS/akentros#readme) and
[docs/openapi.yaml](https://github.com/PrimordialSpirit-SANS/akentros/blob/main/docs/openapi.yaml).
Behavioral invariants are pinned by the repository's contract-test suite;
versioned releases follow the monorepo's [CHANGELOG](https://github.com/PrimordialSpirit-SANS/akentros/blob/main/CHANGELOG.md).

## License

[MIT](./LICENSE) — © 2026 PrimordialSpirit-Akentros. Third-party brand names and trademarks belong to their respective owners.
