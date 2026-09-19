# QwenCloud integration

QwenCloud uses Alibaba Cloud Model Studio's Singapore OpenAI-compatible endpoint:
`https://dashscope-intl.aliyuncs.com/compatible-mode/v1`.
The backend sends bearer authentication and translates Akentros `max_completion_tokens`
to DashScope `max_tokens`. Streaming requests include usage for token billing.

## Models and Akentros prices

The following rates use the [official Singapore API prices](https://www.alibabacloud.com/help/en/model-studio/model-pricing)
checked on 2026-09-11. The approved conversion is `ceil(USD × 33.33)` points,
applied separately to each rate per million tokens. Each request costs at least
one point; existing Akentros billing rounds the combined input/output charge up once.

| Public model | Upstream model | USD input / output per 1M | Akentros points input / output per 1M |
| --- | --- | --- | --- |
| `akentros/qwen-3.8-max` | `qwen3.8-max` | 2 / 6 | 67 / 200 |
| `akentros/qwen-3.8-flash` | `qwen3.8-flash` | 0.15 / 0.48 | 5 / 16 |
| `akentros/glm-5.3` | `glm-5.3` | 1.41 / 4.41 | 47 / 147 |
| `akentros/glm-5.3-flash` | `glm-5.3-flash` | 0.15 / 0.6 | 5 / 20 |
| `akentros/kimi-k3` | `kimi-k3` | 3 / 15 | 100 / 500 |
| `akentros/deepseek-v4.1-flash` | `deepseek-v4.1-flash` | 0.15 / 0.6 | 5 / 20 |
| `akentros/deepseek-v4-pro` | `deepseek-v4-pro-0813` | 1.32 / 3.96 | 44 / 132 |

Most routes use the undated model IDs, including `deepseek-v4.1-flash`
(released 2026-09-10 as an open-weight MIT model, replacing the retired
`deepseek-v4-flash`). DeepSeek V4 Pro is the one exception and serves the dated
`deepseek-v4-pro-0813` snapshot, whose Singapore rates differ between peak and
idle hours. Akentros bills the peak rates so idle-hour discounts, cache discounts
and promotions are all excluded from the published rates.
Rates exclude temporary promotions and cache discounts.

Akentros exposes text chat, streaming, reasoning output and function tools for these
models. The service output limit is 8,192 tokens, with 4,096 by default. Model
context limits are 1,000,000 tokens, except Kimi K3 at 1,048,576. Qwen input is
capped at 983,616 tokens to respect its thinking-mode input limit. Other input
limits reserve 8,192 tokens within the context for completion.

The public catalog's `input_modalities` describes native model capabilities:
Qwen 3.8 Max and Qwen 3.8 Flash support text, images and video; Kimi K3
supports text and images according to their Singapore model specifications.
Both output text. Their model cards show native multimodal support and explain
that the Akentros API currently accepts text only; backend route capabilities
describe this API limit.

Provider `completion_tokens` includes reasoning tokens. Akentros bills this total
once and preserves the optional `completion_tokens_details.reasoning_tokens`
subset in chat responses. The test page labels output as including reasoning;
its reasoning character count is text length, not a tokenizer count. Without
valid provider usage, the existing estimate includes visible reasoning text,
but cannot measure hidden reasoning exactly.

Model references: [Qwen 3.8 Max](https://www.alibabacloud.com/help/en/model-studio/qwen3-8-max),
[Qwen 3.8 Flash](https://www.alibabacloud.com/help/en/model-studio/qwen3-8-flash),
[GLM](https://www.alibabacloud.com/help/en/model-studio/glm),
[Kimi K3](https://www.alibabacloud.com/help/en/model-studio/kimi-k3),
[DeepSeek V4.1 Flash](https://api-docs.deepseek.com/updates/),
[DeepSeek V4 Pro](https://www.alibabacloud.com/help/en/model-studio/deepseek-v4-pro).

## Credentials and verification

Set `QWENCLOUD_API_KEY_1` in the ignored `apps/gateway/.dev.vars` for local
development. Production uses the same name as a Worker secret. Never add its
value to tracked configuration or frontend assets. Follow the
[deployment runbook](DEPLOYMENT.md) when releasing the Worker and catalog.

The diagnostics are offline by default. Live calls use a small fixed test prompt
and a maximum of 512 completion tokens per QwenCloud model, bypassing Akentros account
billing. They incur the provider's normal API usage charges and print only
public model IDs and diagnostic status.

```text
npm run probe:akentros-provider -- --provider=qwencloud
npm run probe:akentros-provider -- --provider=qwencloud --all --live
npm run probe:akentros-provider -- --provider=qwencloud --all --live --stream
```
