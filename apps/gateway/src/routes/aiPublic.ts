import { Hono } from "hono";
import {
  createBeaconInferenceRuntime,
  listPublicBeaconModels,
  measureStreamChunkOutputChars,
  normalizeStreamChunk,
  prepareBeaconChatRequest,
  publicProviderError,
} from "../../../../packages/core/src/inference.ts";
import { BACKEND_PRICING } from "../../../../packages/core/src/pricing.ts";
import { BeaconProviderError } from "../../../../packages/core/src/providers.ts";
import { authenticateBeaconKey, requireAiScope } from "../middleware/aiAuth.ts";
import {
  markBeaconDispatched,
  markBeaconNeedsReconciliation,
  readBeaconBilling,
  refundBeaconSpend,
  reserveBeaconSpend,
  settleBeaconSpend,
} from "../utils/aiBilling.ts";
import { BeaconError, invalidRequest, openAiErrorBody, sendOpenAiError } from "../utils/aiErrors.ts";
import { acquireBeaconApiLimit, releaseBeaconApiLimit } from "../utils/aiLimits.ts";
import { finishBeaconProviderAttempt, startBeaconProviderAttempt } from "../utils/aiProviderAttempts.ts";
import { claimBeaconProviderCredential, releaseBeaconProviderCredential } from "../utils/aiProviderPool.ts";

export const aiPublicRoutes = new Hono();

function newRequestId() {
  return `req_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
}

function setPublicHeaders(c: any, requestId: any) {
  c.header("Cache-Control", "no-store, no-transform");
  c.header("X-Request-Id", requestId);
  c.header("X-Beacon-Pricing-Revision", BACKEND_PRICING.revision);
}

function runtimeFor(env: any) {
  return createBeaconInferenceRuntime({
    billing: {
      reserve: (input: any) => reserveBeaconSpend(env, input),
      read: (requestId: any) => readBeaconBilling(env, requestId),
      markDispatched: (requestId: any) => markBeaconDispatched(env, requestId),
      settle: (input: any) => settleBeaconSpend(env, input),
      refund: (input: any) => refundBeaconSpend(env, input),
      markNeedsReconciliation: (input: any) => markBeaconNeedsReconciliation(env, input),
    },
    attempts: {
      start: (input: any) => startBeaconProviderAttempt(env, input),
      finish: (attempt: any, outcome: any) => finishBeaconProviderAttempt(env, attempt, outcome),
    },
    claimCredential: (route: any, requestId: any, excludedCredentialIds: any) =>
      claimBeaconProviderCredential(env, route, requestId, excludedCredentialIds),
    releaseCredential: (claim: any, outcome: any) => releaseBeaconProviderCredential(env, claim, outcome),
    cloudflareAiBinding: null, // Bypassed to prevent using Wrangler CLI logged-in account
  });
}

async function readPublicJsonObject(c: any) {
  let value: any;
  try {
    value = await c.req.json();
  } catch {
    throw new BeaconError("The request body is not valid JSON.", {
      status: 400,
      type: "invalid_request_error",
      code: "invalid_json",
    });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidRequest("The request body must be a JSON object.");
  }
  return value;
}

function visibleModels(aiKey: any) {
  const list = listPublicBeaconModels();
  if (!Array.isArray(aiKey.model_allowlist) || aiKey.model_allowlist.length === 0) return list;
  return { ...list, data: list.data.filter((model) => aiKey.model_allowlist.includes(model.id)) };
}

aiPublicRoutes.use("*", async (c: any, next: any) => {
  c.set("aiRequestId", newRequestId());
  setPublicHeaders(c, c.get("aiRequestId"));
  await next();
});
aiPublicRoutes.use("*", authenticateBeaconKey);

aiPublicRoutes.get("/models", requireAiScope("models:read"), (c: any) => {
  return c.json(visibleModels(c.get("aiKey")));
});

export async function handleBeaconChatCompletions(c: any, aiKeyOrResolver = c.get("aiKey")) {
  if (!c.get("aiRequestId")) {
    c.set("aiRequestId", newRequestId());
  }
  setPublicHeaders(c, c.get("aiRequestId"));
  let prepared: any;
  let streamContext: any;
  let admissionAcquired = false;
  let admissionReleasePromise: Promise<unknown> | null = null;
  const releaseAdmissionOnce = () => {
    if (!admissionAcquired || !prepared?.requestId) return Promise.resolve();
    if (!admissionReleasePromise) {
      admissionReleasePromise = releaseBeaconApiLimit(c.env, prepared.requestId)
        .catch(() => {})
        .finally(() => {
          admissionAcquired = false;
        });
    }
    return admissionReleasePromise;
  };
  try {
    const aiKey = typeof aiKeyOrResolver === "function" ? await aiKeyOrResolver() : aiKeyOrResolver;
    if (!aiKey) {
      throw new BeaconError("Beacon authentication is unavailable.", {
        status: 503,
        type: "service_unavailable",
        code: "authentication_unavailable",
      });
    }
    prepared = await prepareBeaconChatRequest({
      body: await readPublicJsonObject(c),
      aiKey,
      idempotencyKey: c.req.header("idempotency-key") || null,
    });
    c.set("aiRequestId", prepared.requestId);
    setPublicHeaders(c, prepared.requestId);
    await acquireBeaconApiLimit(c.env, {
      apiKeyId: aiKey.id,
      requestId: prepared.requestId,
      rpmLimit: aiKey.rpm_limit,
      maxInFlight: aiKey.max_in_flight,
      // 租約必須涵蓋整個推論階段(最長可達 8 次 provider 嘗試)。對齊保留單
      // 的 5 分鐘窗口,避免租約提前過期使 max_in_flight 在尾段失去保護。
      leaseTtlMs: 5 * 60_000,
    });
    admissionAcquired = true;
    if (c.req.raw.signal.aborted) {
      throw new BeaconProviderError("The client disconnected before dispatch.", {
        category: "client_disconnected",
        fallbackAllowed: false,
      });
    }
    const runtime = runtimeFor(c.env);

    if (!prepared.stream) {
      try {
        const result = await runtime.executeJson(prepared, { signal: c.req.raw.signal });
        return c.json(result.body);
      } finally {
        await releaseAdmissionOnce();
      }
    }

    const providerAbortController = new AbortController();
    const requestSignal = c.req.raw.signal;
    const abortFromRequest = () =>
      providerAbortController.abort(requestSignal.reason || new Error("client_disconnected"));
    if (requestSignal.aborted) abortFromRequest();
    else requestSignal.addEventListener("abort", abortFromRequest, { once: true });
    try {
      streamContext = await runtime.openStream(prepared, { signal: providerAbortController.signal });
    } catch (error: any) {
      requestSignal.removeEventListener("abort", abortFromRequest);
      throw error;
    }
    const encoder = new TextEncoder();
    let cancelled = false;
    const stream = new ReadableStream({
      async start(controller) {
        let usage = null;
        let sawDone = false;
        try {
          for await (const event of streamContext.events) {
            if (event.data === "[DONE]") {
              sawDone = true;
              break;
            }
            let upstream: any;
            try {
              upstream = JSON.parse(event.data);
            } catch (cause) {
              throw new BeaconProviderError("The model stream contained invalid JSON.", {
                provider: "unknown",
                category: "invalid_provider_response",
                fallbackAllowed: false,
                responseStarted: true,
                usageUnknown: true,
                cause,
              });
            }
            const chunk = normalizeStreamChunk(upstream, prepared);
            if (chunk.usage) {
              usage = chunk.usage;
              // 同步記錄至 streamContext,讓 failStream(客戶端中斷時)能據此
              // 正確結算已實際消耗的 token,而非一律標記為待核對。
              streamContext.receivedUsage = usage;
            }
            // 逐 chunk 累計實際輸出長度:串流正常結束但 provider 未回報
            // usage 時,finalizeStream 以此做保守估計結算(而非全額退款)。
            streamContext.estimatedOutputChars =
              (streamContext.estimatedOutputChars || 0) + measureStreamChunkOutputChars(chunk);
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          }
          if (!sawDone) {
            throw new BeaconProviderError("The model stream ended unexpectedly.", {
              provider: "unknown",
              category: "stream_interrupted",
              fallbackAllowed: false,
              responseStarted: true,
              usageUnknown: true,
            });
          }
          await runtime.finalizeStream(streamContext, usage);
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        } catch (error: any) {
          try {
            await runtime.failStream(streamContext, error);
          } catch {
            // The original stream failure remains the public error.
          }
          const safe = publicProviderError(error);
          const envelope = openAiErrorBody(
            safe instanceof BeaconError
              ? safe
              : new BeaconError("Beacon streaming was interrupted.", {
                  status: 503,
                  type: "server_error",
                  code: "service_unavailable",
                }),
          );
          if (!cancelled) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(envelope)}\n\n`));
          }
        } finally {
          requestSignal.removeEventListener("abort", abortFromRequest);
          await releaseAdmissionOnce();
          if (!cancelled) controller.close();
        }
      },
      async cancel(reason) {
        cancelled = true;
        providerAbortController.abort(
          Object.assign(new Error("client_disconnected"), {
            cause: reason,
          }),
        );
        try {
          await runtime.failStream(
            streamContext,
            Object.assign(new Error("client_disconnected"), {
              code: "client_disconnected",
              usageUnknown: true,
              cause: reason,
            }),
          );
        } catch {
          // Cancellation cannot change a closed client connection.
        }
        requestSignal.removeEventListener("abort", abortFromRequest);
        await releaseAdmissionOnce();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store, no-transform",
        "x-request-id": prepared.requestId,
        "x-beacon-pricing-revision": BACKEND_PRICING.revision,
      },
    });
  } catch (error: any) {
    if (admissionAcquired && prepared?.requestId) {
      await releaseAdmissionOnce();
    }
    const safe = publicProviderError(error);
    return sendOpenAiError(c, safe, error?.requestId || prepared?.requestId || c.get("aiRequestId") || "");
  }
}

aiPublicRoutes.post("/chat/completions", requireAiScope("chat:completions"), (c: any) =>
  handleBeaconChatCompletions(c),
);

aiPublicRoutes.all("*", (c: any) =>
  sendOpenAiError(
    c,
    new BeaconError("The requested Beacon endpoint does not exist.", {
      status: 404,
      type: "invalid_request_error",
      code: "route_not_found",
    }),
    c.get("aiRequestId"),
  ),
);
