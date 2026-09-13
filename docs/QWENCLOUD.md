# QwenCloud integration

QwenCloud uses Alibaba Cloud Model Studio's Singapore OpenAI-compatible endpoint:
`https://dashscope-intl.aliyuncs.com/compatible-mode/v1`.
The backend sends bearer authentication and translates Beacon `max_completion_tokens`
to DashScope `max_tokens`. Streaming requests include usage for token billing.

## Models and Beacon prices

The following rates use the [official Singapore API prices](https://www.alibabacloud.com/help/en/model-studio/model-pricing)
checked on 2026-09-11. The approved conversion is `ceil(USD × 33.33)` points,
applied separately to each rate per million tokens. Each request costs at least
one point; existing Beacon billing rounds the combined input/output charge up once.

| Public model | Upstream model | USD input / output per 1M | Beacon points input / output per 1M |
| --- | --- | --- | --- |
| `beacon/qwen-3.8-max` | `qwen3.8-max` | 2 / 6 | 67 / 200 |
| `beacon/qwen-3.8-flash` | `qwen3.8-flash` | 0.15 / 0.47 | 5 / 16 |
| `beacon/glm-5.2` | `glm-5.2` | 1.4 / 4.4 | 47 / 147 |
| `beacon/kimi-k3` | `kimi-k3` | 3 / 15 | 100 / 500 |
| `beacon/deepseek-v4-flash` | `deepseek-v4-flash` | 0.2 / 0.4 | 7 / 14 |
| `beacon/deepseek-v4-pro` | `deepseek-v4-pro-0813` | 1.32 / 3.96 | 44 / 132 |

Most routes use the undated model IDs, including `deepseek-v4-flash`; the
separate `deepseek-v4-flash-0731` snapshot has different pricing. DeepSeek V4
Pro is the one exception and serves the dated `deepseek-v4-pro-0813` snapshot,
whose Singapore rates differ between peak and idle hours. Beacon bills the peak
rates so idle-hour discounts, cache discounts and promotions are all excluded
from the published rates.
Rates exclude temporary promotions and cache discounts.

Beacon exposes text chat, streaming, reasoning output and function tools for these
models. The service output limit is 8,192 tokens, with 4,096 by default. Model
context limits are 1,000,000 tokens, except Kimi K3 at 1,048,576. Qwen input is
capped at 983,616 tokens to respect its thinking-mode input limit. Other input
limits reserve 8,192 tokens within the context for completion.

The public catalog's `input_modalities` describes native model capabilities:
Qwen 3.8 Max and Qwen 3.8 Flash support text, images and video; Kimi K3
supports text and images according to their Singapore model specifications.
Both output text. Their model cards show native multimodal support and explain
that the Beacon API currently accepts text only; backend route capabilities
describe this API limit.

Provider `completion_tokens` includes reasoning tokens. Beacon bills this total
once and preserves the optional `completion_tokens_details.reasoning_tokens`
subset in chat responses. The test page labels output as including reasoning;
its reasoning character count is text length, not a tokenizer count. Without
valid provider usage, the existing estimate includes visible reasoning text,
but cannot measure hidden reasoning exactly.

Model references: [Qwen 3.8 Max](https://www.alibabacloud.com/help/en/model-studio/qwen3-8-max),
[Qwen 3.8 Flash](https://www.alibabacloud.com/help/en/model-studio/qwen3-8-flash),
[GLM](https://www.alibabacloud.com/help/en/model-studio/glm),
[Kimi K3](https://www.alibabacloud.com/help/en/model-studio/kimi-k3),
[DeepSeek V4 Flash](https://www.alibabacloud.com/help/en/model-studio/deepseek-v4-flash),
[DeepSeek V4 Pro](https://www.alibabacloud.com/help/en/model-studio/deepseek-v4-pro).

## Credentials and verification

Set `QWENCLOUD_API_KEY_1` in the ignored `apps/gateway/.dev.vars` for local
development. Production uses the same name as a Worker secret. Never add its
value to tracked configuration or frontend assets. Follow the
[deployment runbook](DEPLOYMENT.md) when releasing the Worker and catalog.

The diagnostics are offline by default. Live calls use a small fixed test prompt
and a maximum of 512 completion tokens per QwenCloud model, bypassing Beacon account
billing. They incur the provider's normal API usage charges and print only
public model IDs and diagnostic status.

```text
npm run probe:beacon-provider -- --provider=qwencloud
npm run probe:beacon-provider -- --provider=qwencloud --all --live
npm run probe:beacon-provider -- --provider=qwencloud --all --live --stream
```
