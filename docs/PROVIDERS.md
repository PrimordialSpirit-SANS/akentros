# Akentros upstream providers

Akentros routes every public model through an upstream provider pool defined in
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
Akentros endpoint. Every pool credential resolves its secret from a Worker
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

## Models and Akentros prices

The published catalog covers 19 models from eight model families (OpenAI GPT,
Anthropic Claude, Google Gemini, xAI Grok, DeepSeek, Moonshot AI Kimi, Z.ai
GLM, and Alibaba Qwen). Rates use each provider's official public API prices
checked on 2026-09-14. Akentros passes the upstream USD rate through with a small
settlement margin (`input_usd_per_million_tokens` / `output_usd_per_million_tokens`,
USD decimals), with a $0.0001 per-request minimum. Cache discounts, batch
discounts, tiered long-context pricing, and promotions are excluded from the
published rates.

### OpenAI (`https://api.openai.com/v1`)

| Public model | Upstream model | USD in / out per 1M | Points in / out per 1M |
| --- | --- | --- | --- |
| `akentros/gpt-6-astra` | `gpt-6-astra` | 10 / 50.01 | 334 / 1667 |
| `akentros/gpt-5.2` | `gpt-5.2` | 1.26 / 10.02 | 42 / 334 |
| `akentros/gpt-5.2-codex` | `gpt-5.2-codex` | 1.26 / 10.02 | 42 / 334 |

Contexts: GPT-6 Astra 1,000,000 tokens; GPT-5.2 and GPT-5.2 Codex 400,000.

### Anthropic (`https://api.anthropic.com/v1`, Messages API)

| Public model | Upstream model | USD in / out per 1M | Points in / out per 1M |
| --- | --- | --- | --- |
| `akentros/claude-opus-4-8` | `claude-opus-4-8` | 5 / 25.01 | 167 / 834 |
| `akentros/claude-sonnet-5` | `claude-sonnet-5` | 2 / 10.01 | 67 / 334 |
| `akentros/claude-haiku-4-5` | `claude-haiku-4-5` | 1.02 / 5.01 | 34 / 167 |

Context 200,000 tokens. Prompt-cache write/read discounts are excluded.

### Google Gemini (`https://generativelanguage.googleapis.com/v1beta/openai`)

| Public model | Upstream model | USD in / out per 1M | Points in / out per 1M |
| --- | --- | --- | --- |
| `akentros/gemini-3.5-pro` | `gemini-3.5-pro` | 2.01 / 12.02 | 67 / 401 |
| `akentros/gemini-3.8-flash` | `gemini-3.8-flash` | 0.30 / 2.52 | 10 / 84 |
| `akentros/gemini-3.5-flash-lite` | `gemini-3.5-flash-lite` | 0.12 / 0.42 | 4 / 14 |

Context 1,048,576 tokens. Akentros bills the baseline tier; tiered long-context
pricing above 200k inputs is not reflected in the published rates, so very
large prompts can exceed the modeled upstream cost.

### xAI Grok (`https://api.x.ai/v1`)

| Public model | Upstream model | USD in / out per 1M | Points in / out per 1M |
| --- | --- | --- | --- |
| `akentros/grok-4.6` | `grok-4.6` | 2 / 6.01 | 67 / 201 |
| `akentros/grok-4.1-fast` | `grok-4.1-fast` | 0.21 / 0.51 | 7 / 17 |

Context 2,000,000 tokens for both models. Grok 4.6 applies higher long-context
rates above 200k inputs; Akentros bills the standard tier.

### DeepSeek (`https://api.deepseek.com/v1`)

| Public model | Upstream model | USD in / out per 1M | Points in / out per 1M |
| --- | --- | --- | --- |
| `akentros/deepseek-v4-pro` | `deepseek-v4-pro` | 1.32 / 3.96 | 44 / 132 |
| `akentros/deepseek-v4.1-flash` | `deepseek-v4.1-flash` | 0.15 / 0.6 | 5 / 20 |

Context 1,000,000 tokens. The 2026-08-16 DeepSeek price increase, off-peak
discounts and cache-hit pricing are excluded.

### Moonshot AI Kimi (`https://api.moonshot.ai/v1`)

| Public model | Upstream model | USD in / out per 1M | Points in / out per 1M |
| --- | --- | --- | --- |
| `akentros/kimi-k3` | `kimi-k3` | 3 / 15 | 100 / 500 |

Context 1,048,576 tokens. Kimi K3 is the July 2026 open-weight flagship
(2.8T-parameter MoE with native vision input).

### Z.ai GLM (`https://api.z.ai/api/paas/v4`)

| Public model | Upstream model | USD in / out per 1M | Points in / out per 1M |
| --- | --- | --- | --- |
| `akentros/glm-5.3` | `glm-5.3` | 1.41 / 4.41 | 47 / 147 |
| `akentros/glm-5.3-flash` | `glm-5.3-flash` | 0.15 / 0.6 | 5 / 20 |

Context 1,000,000 tokens. GLM-5.3 (August 2026) is the open-weight coding
flagship; GLM-5.3 Flash is the natively multimodal 320B/18B-active model.

### QwenCloud (`https://dashscope-intl.aliyuncs.com/compatible-mode/v1`)

| Public model | Upstream model | USD in / out per 1M | Points in / out per 1M |
| --- | --- | --- | --- |
| `akentros/qwen-3.8-max` | `qwen3.8-max` | 2.01 / 6 | 67 / 200 |
| `akentros/qwen-3.8-flash` | `qwen3.8-flash` | 0.15 / 0.48 | 5 / 16 |

Context 1,000,000 tokens (input capped at 983,616). See
[QWENCLOUD.md](QWENCLOUD.md) for the full QwenCloud integration notes,
including the GLM, Kimi and DeepSeek models it serves as a fallback route.

### Cloudflare Workers AI (native binding + REST)

| Public model | Upstream model | USD in / out per 1M | Points in / out per 1M |
| --- | --- | --- | --- |
| `akentros/qwen-3.8-27b` | `@cf/qwen/qwen3.8-27b` | 0.42 / 3 | 14 / 100 |

Context 262,144 tokens. Served through the Worker's native AI binding (with a
REST fallback transport); tool calling is not exposed for this route.

### Multi-route fallback

`packages/core/config/backend-pricing.v1.json` may attach several routes to
one public model, tried in ascending `priority` order:

| Public model | Routes (priority order) |
| --- | --- |
| `akentros/deepseek-v4-pro` | DeepSeek API `deepseek-v4-pro` (10) → QwenCloud `deepseek-v4-pro-0813` (20) |
| `akentros/deepseek-v4.1-flash` | DeepSeek API `deepseek-v4.1-flash` (10) → QwenCloud `deepseek-v4.1-flash` (20) |
| `akentros/kimi-k3` | Moonshot AI `kimi-k3` (10) → QwenCloud `kimi-k3` (20) |
| `akentros/glm-5.3` | Z.ai BigModel `glm-5.3` (10) → QwenCloud `glm-5.3` (20) |
| `akentros/glm-5.3-flash` | Z.ai BigModel `glm-5.3-flash` (10) → QwenCloud `glm-5.3-flash` (20) |

Public billing stays model-level and is set by the most expensive enabled
route, so a fallback never bills below platform cost.

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

`amazon-bedrock` is registered but currently serves no catalog models. It
connects through Amazon Bedrock's OpenAI-compatible surface
(`https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1`) with a Bedrock
API key — no SigV4 signing or AWS SDK required. Add Bedrock models by using
the Bedrock inference model ID as `upstream_model`, for example
`anthropic.claude-sonnet-4-5-20250929-v1:0` or `meta.llama3-3-70b-instruct-v1:0`.

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

The Akentros provider layer intentionally mirrors the openCode (models.dev)
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

openCode list entries that cannot serve Akentros chat completions and are
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
Akentros billing and incur the provider's normal API charges.

```text
npm run probe:akentros-provider -- --provider=openai --all --live --stream
npm run probe:akentros-provider -- --provider=anthropic --all --live --stream
npm run probe:akentros-provider -- --provider=google --all --live
```
