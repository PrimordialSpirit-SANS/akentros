# Beacon upstream providers

Beacon routes every public model through an upstream provider pool defined in
`packages/core/config/provider-pools.v1.json`. The provider registry lives in
`packages/core/src/validation.ts` and the transport adapters in
`packages/core/src/providers.ts`. This document mirrors the structure of
[QWENCLOUD.md](QWENCLOUD.md) and covers every upstream added since.

## API styles

| api_style | Transport | Providers |
| --- | --- | --- |
| `openai-compatible` | Bearer auth, `POST {base_url}/chat/completions`, OpenAI chunk streaming | `openrouter`, `hugging-face`, `qwencloud`, `openai`, `google`, `xai`, `groq`, `mistral`, `deepseek`, `together`, `fireworks`, `cerebras`, `perplexity`, `cohere`, `moonshot`, `zhipu`, `minimax`, `nvidia`, `deepinfra`, `sambanova`, `lambda`, `friendli`, `baichuan`, `stepfun`, `hunyuan`, `spark`, `ernie`, `ai21`, `amazon-bedrock`, `azure-openai`, `scaleway`, `ovhcloud`, `custom` |
| `anthropic-messages` | `x-api-key` + `anthropic-version` headers, `POST {base_url}/messages`, Anthropic Messages shape with server-side conversion to OpenAI chunks | `anthropic` |
| `cloudflare-rest` | Bearer auth, per-model REST URL template | `cloudflare-workers-ai` |

All requests run server-side; browsers and API consumers only ever talk to the
Beacon endpoint. Every pool credential resolves its secret from a Worker
secret or `.dev.vars` binding listed below.

## Request parameter quirks

`buildProviderRequest` normalizes the public OpenAI-style body per provider:

- **Output limit.** By default `max_completion_tokens` is translated to the
  universally supported `max_tokens`. Providers in
  `MAX_COMPLETION_TOKENS_PROVIDERS` (`openai`, `google`) keep
  `max_completion_tokens` because their current models reject `max_tokens`.
- **Stream usage.** Streaming requests include
  `stream_options: { include_usage: true }` except for providers in
  `NO_STREAM_OPTIONS_PROVIDERS` (`perplexity`, `cohere`, `amazon-bedrock`),
  which are not known to support the field; usage arrives in their final
  chunk, and missing usage falls back to the conservative estimated
  settlement.
- **QwenCloud.** Same openai-compatible transport; the output limit becomes
  `max_tokens` (see [QWENCLOUD.md](QWENCLOUD.md)).
- **Anthropic.** The adapter converts system/developer messages into the
  `system` parameter, tool results into user `tool_result` blocks, assistant
  tool calls into `tool_use` blocks, folds consecutive same-role turns, maps
  `tool_choice` (`required` → `any`), and drops unsupported fields
  (`seed`, `n`, penalties, `stream_options`). `temperature` wins over `top_p`
  because Anthropic rejects the combination. Responses and SSE streams are
  normalized back into the OpenAI completion/chunk shapes, including
  `thinking` → `reasoning` text and `tool_use` → `tool_calls`.

## Models and Beacon prices

Rates use each provider's official public API prices checked on 2026-09-12.
Beacon passes the upstream USD rate through directly (`input_usd_per_million_tokens`
/ `output_usd_per_million_tokens`, USD decimals), with a $0.0001 per-request minimum. Cache
discounts, batch discounts, tiered long-context pricing, and promotions are
excluded from the published rates.

### OpenAI (`https://api.openai.com/v1`)

| Public model | Upstream model | USD in / out per 1M | Points in / out per 1M |
| --- | --- | --- | --- |
| `beacon/gpt-5` | `gpt-5` | 1.25 / 10 | 42 / 334 |
| `beacon/gpt-5-mini` | `gpt-5-mini` | 0.25 / 2 | 9 / 67 |
| `beacon/gpt-5-nano` | `gpt-5-nano` | 0.05 / 0.40 | 2 / 14 |

Context 400,000 tokens. Gemini-style tiered pricing does not apply; OpenAI
charges one rate per direction.

### Anthropic (`https://api.anthropic.com/v1`, Messages API)

| Public model | Upstream model | USD in / out per 1M | Points in / out per 1M |
| --- | --- | --- | --- |
| `beacon/claude-opus-4-1` | `claude-opus-4-1` | 15 / 75 | 500 / 2500 |
| `beacon/claude-sonnet-4-5` | `claude-sonnet-4-5` | 3 / 15 | 100 / 500 |
| `beacon/claude-haiku-4-5` | `claude-haiku-4-5` | 1 / 5 | 34 / 167 |

Context 200,000 tokens. Prompt-cache write/read discounts are excluded.

### Google Gemini (`https://generativelanguage.googleapis.com/v1beta/openai`)

| Public model | Upstream model | USD in / out per 1M | Points in / out per 1M |
| --- | --- | --- | --- |
| `beacon/gemini-2.5-pro` | `gemini-2.5-pro` | 1.25 / 10 | 42 / 334 |
| `beacon/gemini-2.5-flash` | `gemini-2.5-flash` | 0.30 / 2.50 | 10 / 84 |
| `beacon/gemini-2.5-flash-lite` | `gemini-2.5-flash-lite` | 0.10 / 0.40 | 4 / 14 |

Context 1,048,576 tokens. Beacon bills the ≤200k-input tier; the >200k tier
(`gemini-2.5-pro` at 2.50 / 15) is not reflected in the published rates, so
very large prompts can exceed the modeled upstream cost.

### xAI Grok (`https://api.x.ai/v1`)

| Public model | Upstream model | USD in / out per 1M | Points in / out per 1M |
| --- | --- | --- | --- |
| `beacon/grok-4` | `grok-4` | 3 / 15 | 100 / 500 |
| `beacon/grok-4-fast` | `grok-4-fast-reasoning` | 0.20 / 0.50 | 7 / 17 |
| `beacon/grok-code-fast` | `grok-code-fast-1` | 0.20 / 1.50 | 7 / 50 |

Contexts: Grok 4 and Grok Code Fast 256,000 tokens; Grok 4 Fast 2,000,000.

### Groq (`https://api.groq.com/openai/v1`)

| Public model | Upstream model | USD in / out per 1M | Points in / out per 1M |
| --- | --- | --- | --- |
| `beacon/llama-3.3-70b-instruct` | `llama-3.3-70b-versatile` | 0.59 / 0.79 | 20 / 27 |
| `beacon/kimi-k2-instruct` | `moonshotai/kimi-k2-instruct-0905` | 1 / 3 | 34 / 100 |

Contexts: Llama 3.3 131,072 tokens; Kimi K2 262,144 tokens.

### Mistral AI (`https://api.mistral.ai/v1`)

| Public model | Upstream model | USD in / out per 1M | Points in / out per 1M |
| --- | --- | --- | --- |
| `beacon/mistral-large` | `mistral-large-latest` | 2 / 6 | 67 / 200 |
| `beacon/codestral` | `codestral-latest` | 0.30 / 0.90 | 10 / 30 |

Contexts: Mistral Large 131,072 tokens; Codestral 262,144 tokens.

### DeepSeek (`https://api.deepseek.com/v1`)

| Public model | Upstream model | USD in / out per 1M | Points in / out per 1M |
| --- | --- | --- | --- |
| `beacon/deepseek-v3.2` | `deepseek-chat` | 0.28 / 0.42 | 10 / 14 |
| `beacon/deepseek-v3.2-reasoner` | `deepseek-reasoner` | 0.28 / 0.42 | 10 / 14 |

Context 131,072 tokens. Off-peak discounts and cache-hit pricing are excluded.

### Perplexity (`https://api.perplexity.ai`)

| Public model | Upstream model | USD in / out per 1M | Points in / out per 1M |
| --- | --- | --- | --- |
| `beacon/sonar` | `sonar` | 1 / 1 | 34 / 34 |
| `beacon/sonar-pro` | `sonar-pro` | 3 / 15 | 100 / 500 |

Contexts: Sonar 128,000 tokens; Sonar Pro 200,000 tokens. Perplexity charges a
per-request search fee on top of token usage; the token-based Beacon settlement
does not model that fee, so these routes may settle below upstream cost.
Streaming omits `stream_options` (unsupported); usage arrives in the final
chunk.

### Cohere (`https://api.cohere.ai/compatibility/v1`)

| Public model | Upstream model | USD in / out per 1M | Points in / out per 1M |
| --- | --- | --- | --- |
| `beacon/command-a` | `command-a-03-2025` | 2.50 / 10 | 84 / 334 |
| `beacon/command-r7b` | `command-r7b-12-2024` | 0.0375 / 0.15 | 2 / 5 |

Contexts: Command A 256,000 tokens; Command R7B 128,000 tokens. Streaming
omits `stream_options`; usage falls back to estimated settlement when the
compatibility endpoint does not report it.

### Multi-route fallback

`packages/core/config/backend-pricing.v1.json` may attach several routes to
one public model, tried in ascending `priority` order:

| Public model | Routes (priority order) |
| --- | --- |
| `beacon/gpt-oss-120b` | Cloudflare Workers AI (10) → Groq `openai/gpt-oss-120b` (20) → Amazon Bedrock `openai.gpt-oss-120b-1:0` (30) |
| `beacon/kimi-k3` | QwenCloud (10) → Moonshot AI `kimi-k3` (20) |
| `beacon/glm-5.2` | QwenCloud (10) → Zhipu AI BigModel `glm-5.2` (20) |
| `beacon/kimi-k2-instruct` | Groq (10) → DeepInfra `moonshotai/Kimi-K2` (20) → Fireworks AI (30) |

Public billing stays model-level and is set by the most expensive enabled
route, so a fallback never bills below platform cost.

### MiniMax (`https://api.minimax.io/v1`)

| Public model | Upstream model | USD in / out per 1M | Points in / out per 1M |
| --- | --- | --- | --- |
| `beacon/minimax-m2` | `MiniMax-M2` | 0.30 / 1.20 | 10 / 40 |

Context 200,000 tokens (capped conservatively against MiniMax's published
window). MiniMax M2 interleaves thinking with tool use; reasoning text is not
separately reported through the OpenAI-compatible endpoint.

## Transport-ready providers without catalog models

These pools are registered, validated, and probed but have no public models
yet; add models to `backend-pricing.v1.json` plus the frontend catalogs to
publish them:

| Provider | Base URL | Secret | 備註 |
| --- | --- | --- | --- |
| `together` | `https://api.together.xyz/v1` | `TOGETHER_API_KEY_1` | |
| `fireworks` | `https://api.fireworks.ai/inference/v1` | `FIREWORKS_AI_API_KEY_1` | |
| `cerebras` | `https://api.cerebras.ai/v1` | `CEREBRAS_API_KEY_1` | |
| `nvidia` | `https://integrate.api.nvidia.com/v1` | `NVIDIA_API_KEY_1` | NVIDIA NIM |
| `sambanova` | `https://api.sambanova.ai/v1` | `SAMBANOVA_API_KEY_1` | |
| `lambda` | `https://api.lambda.ai/v1` | `LAMBDA_API_KEY_1` | Lambda Labs |
| `friendli` | `https://inference.friendli.ai/v1` | `FRIENDLI_API_KEY_1` | FriendliAI |
| `baichuan` | `https://api.baichuan-ai.com/v1` | `BAICHUAN_API_KEY_1` | 百川智能 |
| `stepfun` | `https://api.stepfun.com/v1` | `STEPFUN_API_KEY_1` | 階躍星辰 |
| `hunyuan` | `https://api.hunyuan.cloud.tencent.com/v1` | `HUNYUAN_API_KEY_1` | 騰訊混元 |
| `spark` | `https://spark-api-open.xf-yun.com/v1` | `SPARK_API_KEY_1` | 科大訊飛星火；憑證值為 `key:secret` 格式 |
| `ernie` | `https://qianfan.baidubce.com/v2` | `ERNIE_API_KEY_1` | 百度千帆（文心） |
| `ai21` | `https://api.ai21.com/studio/v1` | `AI21_API_KEY_1` | Jamba 系列 |
| `scaleway` | `https://api.scaleway.ai/v1` | `SCALEWAY_API_KEY_1` | Scaleway Generative APIs |
| `ovhcloud` | `https://oai.endpoints.kepler.ai.cloud.ovh.net/v1` | `OVHCLOUD_API_KEY_1` | OVHcloud AI Endpoints |

`amazon-bedrock` serves `beacon/gpt-oss-120b` through Amazon Bedrock's
OpenAI-compatible surface (`https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1`)
with a Bedrock API key — no SigV4 signing or AWS SDK required. Add Bedrock
models by using the Bedrock inference model ID as `upstream_model`, for
example `anthropic.claude-sonnet-4-5-20250929-v1:0` or
`meta.llama3-3-70b-instruct-v1:0`.

The `custom` provider is a disabled template pool
(`custom-gateway-template`) for any OpenAI-compatible endpoint: duplicate it
per private gateway, set its `base_url` to the gateway's `…/v1` HTTPS address
and its credential secret reference, then reference the pool from model
routes. This covers openCode's "custom providers" category — private
deployments, AI gateways, and self-hosted runtimes (vLLM, TGI, Ollama,
LM Studio, LocalAI) exposed behind an HTTPS gateway reachable from Workers.
`azure-openai` follows the same template pattern
(`azure-openai-template`, disabled): duplicate it per resource with
`base_url: https://<resource>.openai.azure.com/openai/v1` and an Azure API
key; the v1 surface accepts Bearer auth and OpenAI parameter names directly.

## Provider vocabulary versus openCode

The Beacon provider layer intentionally mirrors the openCode (models.dev)
provider ecosystem. Currently wired upstreams: `openai`, `anthropic`,
`google`, `xai`, `groq`, `mistral`, `deepseek`, `together`, `fireworks`,
`cerebras`, `perplexity`, `cohere`, `moonshot`, `zhipu`, `minimax`, `nvidia`,
`deepinfra`, `sambanova`, `lambda`, `friendli`, `baichuan`, `stepfun`,
`hunyuan`, `spark`, `ernie`, `ai21`, `amazon-bedrock`, `azure-openai`,
`scaleway`, `ovhcloud`, and the generic `custom`, plus the
pre-existing `openrouter`, `hugging-face`, `qwencloud`, and
`cloudflare-workers-ai`.

openCode providers that need more than an API key and are therefore not
registered yet:

- `google-vertex` — OAuth2 service-account signing.
- `github-copilot` — OAuth device flow with token exchange.

openCode list entries that cannot serve Beacon chat completions and are
intentionally not registered:

- **Image / video / media generators** — Adobe Firefly, Midjourney, Runway,
  Luma AI, Pika Labs, Haiper, Stability AI, Character.AI: no chat-completions
  surface.
- **Consumer writing tools** — Jasper, Copy.ai, Rytr, Sudowrite, Inflection:
  no public model API.
- **Hardware / silicon vendors** — Ayar Labs, Graphcore, Habana Labs,
  Lightmatter, Tenstorrent: they do not host a public inference API under
  these brands.
- **Self-hosted runtimes and local apps** — Ollama, vLLM, TGI, LM Studio,
  LocalAI, llama.cpp, MLC LLM, Petals, Jan, GPT4All: localhost or intranet
  endpoints are unreachable from the hosted Worker; front them with the
  `custom` provider over an HTTPS gateway.
- **Account-scoped enterprise platforms** — Databricks, Snowflake Cortex,
  IBM Watsonx, ServiceNow, Workday AI, CoreWeave, RunPod, Baseten,
  Lepton AI: each needs a customer-specific base URL; add a `custom`-style
  pool per endpoint, or a dedicated provider entry when a stable
  multi-tenant endpoint exists.
- **Discontinued or absorbed services** — OctoAI (sunset), Anyscale
  Endpoints (sunset), Adept AI (acquired), OpenCode Go / OpenCode Zen
  (no stable public API at the time of writing).

## Adding a provider

1. Register the provider and its `api_style` in
   `packages/core/src/validation.ts` (`PROVIDER_API_STYLES`).
2. Add a `<provider>-production` pool to `provider-pools.v1.json` (and keep
   `revision` in sync with `backend-pricing.v1.json`).
3. Extend `providers.ts` only when the provider needs a new transport or
   parameter quirk; plain OpenAI-compatible upstreams need no code change.
4. Add models with routes to `backend-pricing.v1.json` using
   `ceil(USD × 33.33)` per direction, and mirror them in the frontend
   catalogs (`models.v1.json`, `provider-offerings.v1.json`) and the brand
   manifest.
5. Document the secret in `apps/gateway/.dev.vars.example`,
   `apps/gateway/wrangler.jsonc` (Workers secrets via `wrangler secret put`), and
   [DEPLOYMENT.md](DEPLOYMENT.md).

## Credentials and verification

Secrets follow the `<PROVIDER>_API_KEY_1` naming in
`apps/gateway/.dev.vars.example`. Never add their values to tracked
configuration. The diagnostics are offline by default; live probes bypass
Beacon billing and incur the provider's normal API charges.

```text
npm run probe:beacon-provider -- --provider=openai --all --live --stream
npm run probe:beacon-provider -- --provider=anthropic --all --live --stream
npm run probe:beacon-provider -- --provider=google --all --live
```
