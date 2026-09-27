import {
  createAkentrosInferenceRuntime,
  listPublicAkentrosModels,
  measureStreamChunkOutputChars,
  normalizeStreamChunk,
  prepareAkentrosChatRequest,
  prepareAkentrosEmbeddingsRequest,
  publicProviderError,
} from "@akentros/core/inference";
import { BACKEND_PRICING } from "@akentros/core/pricing";
import { AkentrosProviderError } from "@akentros/core/providers";
import { Hono } from "hono";
import { authenticateAkentrosKey, requireAiScope, requireAnyAiScope } from "../middleware/aiAuth.ts";
import type {
  AkentrosAuthenticatedKey,
  AkentrosContext,
  AkentrosEnv,
  AkentrosNext,
  AkentrosRuntimeEnv,
} from "../types.ts";
import {
  markAkentrosDispatched,
  markAkentrosNeedsReconciliation,
  refundAkentrosSpend,
  reserveAkentrosSpend,
  settleAkentrosSpend,
} from "../utils/aiBilling.ts";
import { AkentrosError, invalidRequest, openAiErrorBody, sendOpenAiError } from "../utils/aiErrors.ts";
import {
  readAkentrosIdempotentReplay,
  recordAkentrosIdempotentReplay,
  saveAkentrosIdempotentReplay,
} from "../utils/aiIdempotency.ts";
import { acquireAkentrosApiLimit, releaseAkentrosApiLimit } from "../utils/aiLimits.ts";
import { finishAkentrosProviderAttempt, startAkentrosProviderAttempt } from "../utils/aiProviderAttempts.ts";
import {
  claimAkentrosProviderCredential,
  releaseAkentrosProviderCredential,
} from "../utils/aiProviderPool.ts";
import { AKENTROS_PUBLIC_BODY_MAX_BYTES, readCappedText } from "../utils/bodyLimit.ts";
import { recordAkentrosAiRequest } from "../utils/metrics.ts";

export const aiPublicRoutes = new Hono<AkentrosEnv>();

function newRequestId() {
  return `req_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
}

function setPublicHeaders(c: AkentrosContext, requestId: string) {
  c.header("Cache-Control", "no-store, no-transform");
  c.header("X-Request-Id", requestId);
  c.header("X-Akentros-Pricing-Revision", BACKEND_PRICING.revision);
}

function publicEndpointLabel(path: string) {
  if (path.endsWith("/chat/completions")) return "chat.completions";
  if (path.endsWith("/embeddings")) return "embeddings";
  if (path.endsWith("/models")) return "models";
  return "other";
}

// 觀測:記錄公開 AI 面每個請求的 endpoint、HTTP 狀態與延遲。資料由 Node
// 拓撲的 /metrics 以 Prometheus 文字格式輸出;Workers 拓撲計數留在隔離區內
// 不輸出,成本可忽略。
aiPublicRoutes.use("*", async (c: AkentrosContext, next: AkentrosNext) => {
  const startedAt = Date.now();
  try {
    await next();
  } finally {
    recordAkentrosAiRequest(publicEndpointLabel(c.req.path), c.res?.status ?? 0, Date.now() - startedAt);
  }
});

// createAkentrosInferenceRuntime 的 options 由 @akentros/core/inference 的
// AkentrosInferenceRuntimeOptions 契約定型;此處的注入 lambda 參數型別由該
// 契約推導,不必再以 any 標註。
function runtimeFor(env: AkentrosRuntimeEnv) {
  return createAkentrosInferenceRuntime({
    billing: {
      reserve: (input) => reserveAkentrosSpend(env, input),
      markDispatched: (requestId) => markAkentrosDispatched(env, requestId),
      settle: (input) => settleAkentrosSpend(env, input),
      refund: (input) => refundAkentrosSpend(env, input),
      markNeedsReconciliation: (input) => markAkentrosNeedsReconciliation(env, input),
    },
    attempts: {
      start: (input) => startAkentrosProviderAttempt(env, input),
      finish: (attempt, outcome) => finishAkentrosProviderAttempt(env, attempt, outcome),
    },
    claimCredential: (route, requestId, excludedCredentialIds) =>
      claimAkentrosProviderCredential(
        env,
        route as { credential_pool: string },
        requestId,
        excludedCredentialIds,
      ),
    releaseCredential: (claim, outcome) => releaseAkentrosProviderCredential(env, claim, outcome),
    cloudflareAiBinding: null, // Bypassed to prevent using Wrangler CLI logged-in account
  });
}

async function readPublicJsonObject(c: AkentrosContext): Promise<Record<string, unknown>> {
  // 請求體以串流計數上限讀取(Content-Length 預檢 + 逐塊硬上限):Hono 的
  // json()/text() 會先全量緩衝,持金鑰的高 RPM 客戶端可用超大請求體放大
  // 記憶體壓力。上限 32MB 覆蓋目錄最大輸入(約 2M token)與 tools 餘量。
  let text: string;
  try {
    text = await readCappedText(c, AKENTROS_PUBLIC_BODY_MAX_BYTES);
  } catch (error) {
    if (error instanceof AkentrosError) throw error;
    throw invalidRequest("The request body is not valid JSON.", null, "invalid_json");
  }
  let value: unknown;
  try {
    value = text ? JSON.parse(text) : undefined;
  } catch {
    throw new AkentrosError("The request body is not valid JSON.", {
      status: 400,
      type: "invalid_request_error",
      code: "invalid_json",
    });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidRequest("The request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function visibleModels(aiKey: AkentrosAuthenticatedKey) {
  const list = listPublicAkentrosModels();
  if (!Array.isArray(aiKey.model_allowlist) || aiKey.model_allowlist.length === 0) return list;
  return { ...list, data: list.data.filter((model) => aiKey.model_allowlist.includes(model.id)) };
}

// 冪等重放:金鑰 opt-in(idempotency_replay_ttl_seconds > 0)時,完成鍵重送
// 且指紋一致 → 直接重放原始回應(OpenAI 語意);未 opt-in 時不讀寫重放表,
// 完成鍵重送維持 409 idempotent_request_replayed。重放不執行推論,也不計入
// RPM/併發(在 admission 之前短路),但會落一列 status='replayed' 的輕量
// 請求紀錄,避免重放在管理面完全隱形。
async function replayForPrepared(env: AkentrosRuntimeEnv, aiKey: any, prepared: any) {
  const idempotencyKey = prepared?.reservation?.idempotencyKey;
  if (!idempotencyKey || !(Number(aiKey?.idempotency_replay_ttl_seconds) > 0)) return null;
  const replay = await readAkentrosIdempotentReplay(env, {
    apiKeyId: aiKey.id,
    idempotencyKey,
    requestFingerprint: prepared.reservation.requestFingerprint,
  });
  if (!replay) return null;
  try {
    await recordAkentrosIdempotentReplay(env, {
      requestId: prepared.requestId,
      replayedRequestId: replay.requestId,
      userId: prepared.reservation.userId,
      apiKeyId: aiKey.id,
      requestFingerprint: prepared.reservation.requestFingerprint,
      endpoint: prepared.endpoint || prepared.reservation.endpoint,
      stream: Boolean(prepared.stream),
      publicModel: prepared.modelId,
      pricingRevision: prepared.reservation.pricingRevision,
    });
  } catch {
    // 紀錄寫入失敗不影響重放回應;重放本身不受影響。
  }
  return replay;
}

function replayToResponse(
  c: AkentrosContext,
  replay: { status: number; contentType: string; payload: string },
) {
  return new Response(replay.payload, {
    status: replay.status,
    headers: {
      "content-type": replay.contentType,
      "cache-control": "no-store, no-transform",
      "x-request-id": c.get("aiRequestId") || "",
      "x-akentros-pricing-revision": BACKEND_PRICING.revision,
      "x-akentros-idempotent-replay": "true",
    },
  });
}

async function saveReplayForPrepared(
  env: AkentrosRuntimeEnv,
  aiKey: any,
  prepared: any,
  contentType: string,
  payload: string,
) {
  const idempotencyKey = prepared?.reservation?.idempotencyKey;
  const ttlSeconds = Number(aiKey?.idempotency_replay_ttl_seconds) || 0;
  if (!idempotencyKey || ttlSeconds <= 0) return;
  try {
    await saveAkentrosIdempotentReplay(env, {
      requestId: prepared.requestId,
      apiKeyId: aiKey.id,
      idempotencyKey,
      requestFingerprint: prepared.reservation.requestFingerprint,
      endpoint: prepared.endpoint || prepared.reservation.endpoint,
      contentType,
      payload,
      ttlSeconds,
    });
  } catch {
    // 落地失敗不影響回應與計費;完成鍵重送會退回 409 語意,由對帳/日誌觀察。
  }
}

type MaybeKey = AkentrosAuthenticatedKey | null | undefined;
type MaybeKeyOrResolver = MaybeKey | (() => MaybeKey) | (() => Promise<MaybeKey>);

aiPublicRoutes.use("*", async (c: AkentrosContext, next: AkentrosNext) => {
  c.set("aiRequestId", newRequestId());
  setPublicHeaders(c, c.get("aiRequestId") || "");
  await next();
});
aiPublicRoutes.use("*", authenticateAkentrosKey);

aiPublicRoutes.get("/models", requireAiScope("models:read"), (c: AkentrosContext) => {
  return c.json(visibleModels(c.get("aiKey")!));
});

export async function handleAkentrosChatCompletions(
  c: AkentrosContext,
  aiKeyOrResolver: MaybeKeyOrResolver = c.get("aiKey"),
) {
  if (!c.get("aiRequestId")) {
    c.set("aiRequestId", newRequestId());
  }
  setPublicHeaders(c, c.get("aiRequestId") || "");
  // prepared/streamContext 的形狀由 @akentros/core/inference 的未型別化 API 決定。
  let prepared: any;
  let streamContext: any;
  let admissionAcquired = false;
  let admissionReleasePromise: Promise<unknown> | null = null;
  const releaseAdmissionOnce = () => {
    if (!admissionAcquired || !prepared?.requestId) return Promise.resolve();
    if (!admissionReleasePromise) {
      admissionReleasePromise = releaseAkentrosApiLimit(c.env, prepared.requestId)
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
      throw new AkentrosError("Akentros authentication is unavailable.", {
        status: 503,
        type: "service_unavailable",
        code: "authentication_unavailable",
      });
    }
    prepared = await prepareAkentrosChatRequest({
      body: await readPublicJsonObject(c),
      aiKey,
      idempotencyKey: c.req.header("idempotency-key") || null,
    });
    c.set("aiRequestId", prepared.requestId);
    setPublicHeaders(c, prepared.requestId);
    const replay = await replayForPrepared(c.env, aiKey, prepared);
    if (replay) return replayToResponse(c, replay);
    await acquireAkentrosApiLimit(c.env, {
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
      throw new AkentrosProviderError("The client disconnected before dispatch.", {
        category: "client_disconnected",
        fallbackAllowed: false,
      });
    }
    const runtime = runtimeFor(c.env);

    if (!prepared.stream) {
      try {
        const result = await runtime.executeJson(prepared, { signal: c.req.raw.signal });
        await saveReplayForPrepared(c.env, aiKey, prepared, "application/json", JSON.stringify(result.body));
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
    } catch (error) {
      requestSignal.removeEventListener("abort", abortFromRequest);
      throw error;
    }
    const encoder = new TextEncoder();
    let cancelled = false;
    // 串流重放落地:逐 frame 累積,正常完成並結算後整串存入重放表。
    const replayFrames: string[] = [];
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
              throw new AkentrosProviderError("The model stream contained invalid JSON.", {
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
            const frame = `data: ${JSON.stringify(chunk)}\n\n`;
            replayFrames.push(frame);
            controller.enqueue(encoder.encode(frame));
          }
          if (!sawDone) {
            throw new AkentrosProviderError("The model stream ended unexpectedly.", {
              provider: "unknown",
              category: "stream_interrupted",
              fallbackAllowed: false,
              responseStarted: true,
              usageUnknown: true,
            });
          }
          await runtime.finalizeStream(streamContext, usage);
          if (replayFrames.length > 0) {
            // 結算已完成,整串(含結尾 [DONE])落地供完成鍵重放。
            replayFrames.push("data: [DONE]\n\n");
            await saveReplayForPrepared(c.env, aiKey, prepared, "text/event-stream", replayFrames.join(""));
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        } catch (error) {
          try {
            await runtime.failStream(streamContext, error);
          } catch {
            // The original stream failure remains the public error.
          }
          const safe = publicProviderError(error);
          const envelope = openAiErrorBody(
            safe instanceof AkentrosError
              ? safe
              : new AkentrosError("Akentros streaming was interrupted.", {
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
        "x-akentros-pricing-revision": BACKEND_PRICING.revision,
      },
    });
  } catch (error) {
    if (admissionAcquired && prepared?.requestId) {
      await releaseAdmissionOnce();
    }
    const safe = publicProviderError(error);
    const errorRequestId = (error as { requestId?: string })?.requestId;
    return sendOpenAiError(c, safe, errorRequestId || prepared?.requestId || c.get("aiRequestId") || "");
  }
}

aiPublicRoutes.post("/chat/completions", requireAiScope("chat:completions"), (c: AkentrosContext) =>
  handleAkentrosChatCompletions(c),
);

// embeddings 無串流路徑,流程與 chat 的非串流分支相同:準備(含保留單)→
// 併發/RPM 限流 → runtime.executeJson(reserve → invoke → settle)→ JSON 回應。
export async function handleAkentrosEmbeddings(
  c: AkentrosContext,
  aiKeyOrResolver: MaybeKeyOrResolver = c.get("aiKey"),
) {
  if (!c.get("aiRequestId")) {
    c.set("aiRequestId", newRequestId());
  }
  setPublicHeaders(c, c.get("aiRequestId") || "");
  let prepared: any;
  let admissionAcquired = false;
  let admissionReleasePromise: Promise<unknown> | null = null;
  const releaseAdmissionOnce = () => {
    if (!admissionAcquired || !prepared?.requestId) return Promise.resolve();
    if (!admissionReleasePromise) {
      admissionReleasePromise = releaseAkentrosApiLimit(c.env, prepared.requestId)
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
      throw new AkentrosError("Akentros authentication is unavailable.", {
        status: 503,
        type: "service_unavailable",
        code: "authentication_unavailable",
      });
    }
    prepared = await prepareAkentrosEmbeddingsRequest({
      body: await readPublicJsonObject(c),
      aiKey,
      idempotencyKey: c.req.header("idempotency-key") || null,
    });
    c.set("aiRequestId", prepared.requestId);
    setPublicHeaders(c, prepared.requestId);
    const replay = await replayForPrepared(c.env, aiKey, prepared);
    if (replay) return replayToResponse(c, replay);
    await acquireAkentrosApiLimit(c.env, {
      apiKeyId: aiKey.id,
      requestId: prepared.requestId,
      rpmLimit: aiKey.rpm_limit,
      maxInFlight: aiKey.max_in_flight,
      // 與 chat 相同:租約涵蓋整個推論階段(含 provider 重試),對齊保留單窗口。
      leaseTtlMs: 5 * 60_000,
    });
    admissionAcquired = true;
    if (c.req.raw.signal.aborted) {
      throw new AkentrosProviderError("The client disconnected before dispatch.", {
        category: "client_disconnected",
        fallbackAllowed: false,
      });
    }
    const runtime = runtimeFor(c.env);
    try {
      const result = await runtime.executeJson(prepared, { signal: c.req.raw.signal });
      await saveReplayForPrepared(c.env, aiKey, prepared, "application/json", JSON.stringify(result.body));
      return c.json(result.body);
    } finally {
      await releaseAdmissionOnce();
    }
  } catch (error) {
    if (admissionAcquired && prepared?.requestId) {
      await releaseAdmissionOnce();
    }
    const safe = publicProviderError(error);
    const errorRequestId = (error as { requestId?: string })?.requestId;
    return sendOpenAiError(c, safe, errorRequestId || prepared?.requestId || c.get("aiRequestId") || "");
  }
}

aiPublicRoutes.post(
  "/embeddings",
  // 既有金鑰僅有 chat:completions 時向後相容放行;新金鑰直接取得 embeddings。
  requireAnyAiScope("embeddings", "chat:completions"),
  (c: AkentrosContext) => handleAkentrosEmbeddings(c),
);

aiPublicRoutes.all("*", (c: AkentrosContext) =>
  sendOpenAiError(
    c,
    new AkentrosError("The requested Akentros endpoint does not exist.", {
      status: 404,
      type: "invalid_request_error",
      code: "route_not_found",
    }),
    c.get("aiRequestId"),
  ),
);
