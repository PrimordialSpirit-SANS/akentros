// 離線示範模式(VITE_AKENTROS_DEMO=1 或網址帶 ?demo=1)時,攔截指向 Akentros 後端的
// fetch,以記憶體內的假資料與模擬 SSE 串流回應,讓控制台在沒有後端的情況下可以完整瀏覽。
// 靜態資源(public/data/akentros 目錄、品牌圖示等)不攔截,仍由實際伺服器提供。

const DEVELOPER_PREFIX = "/api/ai/developer";
const PUBLIC_CHAT_PATH = "/api/ai/v1/chat/completions";
const AUTH_PREFIX = "/api/auth";

interface DemoUser {
  id: string;
  username: string;
  email: string;
  display_name: string;
  role: string;
  balance_usd: string;
}

const DEMO_ACCOUNT: DemoUser = {
  id: "1",
  username: "demo",
  email: "demo@akentros.dev",
  display_name: "Demo",
  role: "admin",
  balance_usd: "420.000000",
};

interface DemoApiKey {
  id: string;
  name: string;
  environment: "live" | "test";
  key_prefix: string;
  key_suffix: string;
  scopes: string[];
  model_allowlist: string[] | null;
  is_active: boolean;
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
  revoked_at: string | null;
  spend_limit_usd: string | null;
  spend_used_usd: string;
  idempotency_replay_ttl_seconds: number;
}

interface DemoLog {
  request_id: string;
  created_at: string;
  api_key_id: string | null;
  key_name: string | null;
  requested_model: string;
  status: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  reserved_usd: string;
  charged_usd: string;
  refunded_usd: string;
  latency_ms: number | null;
  error_code: string | null;
}

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function randomHex(length: number): string {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, length);
}

function seedLog(options: {
  requestId: string;
  minutes: number;
  model: string;
  status: string;
  inputTokens: number;
  outputTokens: number;
  chargedUsd: string;
  refundedUsd?: string;
  refundedPoints?: number;
  latencyMs: number;
  errorCode?: string | null;
}): DemoLog {
  return {
    request_id: options.requestId,
    created_at: minutesAgo(options.minutes),
    api_key_id: "key_demo_prod",
    key_name: "Production",
    requested_model: options.model,
    status: options.status,
    input_tokens: options.inputTokens,
    output_tokens: options.outputTokens,
    total_tokens: options.inputTokens + options.outputTokens,
    reserved_usd: options.chargedUsd,
    charged_usd: options.chargedUsd,
    refunded_usd: options.refundedUsd ?? "0",
    latency_ms: options.latencyMs,
    error_code: options.errorCode ?? null,
  };
}

const state = {
  balance_usd: 420,
  session: null as DemoUser | null,
  keys: [
    {
      id: "key_demo_prod",
      name: "Production",
      environment: "live",
      key_prefix: "sk-akentros-live_8f21",
      key_suffix: "d04a",
      scopes: ["chat:completions", "models:read"],
      model_allowlist: null,
      is_active: true,
      last_used_at: minutesAgo(7),
      expires_at: null,
      created_at: daysAgo(61),
      revoked_at: null,
      spend_limit_usd: null,
      spend_used_usd: "108.600000",
      idempotency_replay_ttl_seconds: 0,
    },
    {
      id: "key_demo_staging",
      name: "Staging",
      environment: "test",
      key_prefix: "sk-akentros-test_44cd",
      key_suffix: "91b7",
      scopes: ["chat:completions", "models:read"],
      model_allowlist: ["akentros/qwen-3.8-27b"],
      is_active: true,
      last_used_at: daysAgo(3),
      expires_at: daysAgo(-30),
      created_at: daysAgo(12),
      revoked_at: null,
      spend_limit_usd: "50.000000",
      spend_used_usd: "3.540000",
      idempotency_replay_ttl_seconds: 3600,
    },
  ] as DemoApiKey[],
  logs: [
    seedLog({
      requestId: "req_demo_9f2c41a8e0b3",
      minutes: 2,
      model: "akentros/qwen-3.8-27b",
      status: "succeeded",
      inputTokens: 412,
      outputTokens: 96,
      chargedUsd: "0.020000",
      latencyMs: 523,
    }),
    seedLog({
      requestId: "req_demo_7b81d0c4a2e6",
      minutes: 26,
      model: "akentros/gpt-5.2",
      status: "succeeded",
      inputTokens: 1204,
      outputTokens: 388,
      chargedUsd: "0.130000",
      latencyMs: 1341,
    }),
    seedLog({
      requestId: "req_demo_1c4e9a77f3d2",
      minutes: 58,
      model: "akentros/glm-5.3",
      status: "succeeded",
      inputTokens: 2531,
      outputTokens: 907,
      chargedUsd: "1.020000",
      latencyMs: 2896,
    }),
    seedLog({
      requestId: "req_demo_44a0b8e1c5d9",
      minutes: 173,
      model: "akentros/grok-4.1-fast",
      status: "refunded",
      inputTokens: 860,
      outputTokens: 212,
      chargedUsd: "0",
      refundedUsd: "0.020000",
      latencyMs: 611,
    }),
    seedLog({
      requestId: "req_demo_b3d7f2a90c68",
      minutes: 421,
      model: "akentros/claude-haiku-4-5",
      status: "succeeded",
      inputTokens: 640,
      outputTokens: 315,
      chargedUsd: "0.330000",
      latencyMs: 902,
    }),
    seedLog({
      requestId: "req_demo_e8156cc2ab04",
      minutes: 688,
      model: "akentros/qwen-3.8-flash",
      status: "rejected",
      inputTokens: 0,
      outputTokens: 0,
      chargedUsd: "0",
      latencyMs: 12,
      errorCode: "rate_limit_exceeded",
    }),
    seedLog({
      requestId: "req_demo_5d90af13e7bb",
      minutes: 902,
      model: "akentros/gemini-3.5-flash-lite",
      status: "succeeded",
      inputTokens: 988,
      outputTokens: 260,
      chargedUsd: "0.150000",
      latencyMs: 733,
    }),
  ] as DemoLog[],
};

const BASE_USAGE = {
  requests: 1284,
  succeeded: 1251,
  failed: 33,
  input_tokens: 3_215_842,
  output_tokens: 1_872_044,
  charged_usd: 549.72,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function errorJson(code: string, status: number): Response {
  return json({ error: { code } }, status);
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function usageSummary() {
  const succeeded = state.logs.filter((log) => log.status === "succeeded");
  const failed = state.logs.filter((log) => log.status !== "succeeded").length;
  const sum = (logs: DemoLog[], field: "input_tokens" | "output_tokens" | "charged_usd") =>
    logs.reduce((total, log) => total + Number(log[field]), 0);
  return {
    balance_usd: state.balance_usd.toFixed(6),
    requests: BASE_USAGE.requests + state.logs.length,
    succeeded: BASE_USAGE.succeeded + succeeded.length,
    failed: BASE_USAGE.failed + failed,
    input_tokens: BASE_USAGE.input_tokens + sum(state.logs, "input_tokens"),
    output_tokens: BASE_USAGE.output_tokens + sum(state.logs, "output_tokens"),
    total_tokens:
      BASE_USAGE.input_tokens +
      BASE_USAGE.output_tokens +
      sum(state.logs, "input_tokens") +
      sum(state.logs, "output_tokens"),
    charged_usd: BASE_USAGE.charged_usd + sum(state.logs, "charged_usd"),
    period_days: 30,
    free_model_quotas: {},
  };
}

function chunkText(text: string, size: number): string[] {
  const characters = Array.from(text);
  const chunks: string[] = [];
  for (let index = 0; index < characters.length; index += size) {
    chunks.push(characters.slice(index, index + size).join(""));
  }
  return chunks;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });

function sseResponse(
  handler: (write: (chunk: string) => void) => Promise<void>,
  signal?: AbortSignal,
): Response {
  const encoder = new TextEncoder();
  const requestId = `req_demo_${randomHex(12)}`;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (chunk: string) => controller.enqueue(encoder.encode(chunk));
      const onAbort = () => {
        try {
          controller.close();
        } catch {
          /* 已關閉 */
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        await handler(write);
      } finally {
        signal?.removeEventListener("abort", onAbort);
        if (!signal?.aborted) {
          try {
            controller.close();
          } catch {
            /* 已關閉 */
          }
        }
      }
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      "x-request-id": requestId,
    },
  });
}

function buildDemoReply(modelId: string, prompt: string): { reasoning: string; content: string } {
  const topic = prompt.replace(/\s+/g, " ").trim().slice(0, 30) || "你的問題";
  return {
    reasoning: /reasoner|gpt-oss|thinking/i.test(modelId)
      ? `使用者想測試 ${modelId} 的串流行為。先確認請求內容,再產出結構化回覆,最後標註這是離線示範資料。`
      : "",
    content: [
      `你好!我是 ${modelId}(離線示範回應)。`,
      "",
      `你提到「${topic}」,以下用示範模式簡單回覆:`,
      "1. 這段文字由前端內建的模擬串流產生,並非真實模型推理。",
      "2. 字元區塊以固定節奏送達,用來驗證 SSE 解析與逐字渲染。",
      "3. 串流結束時會附上 usage 統計與 [DONE] 訊號,格式與 OpenAI 相容。",
      "",
      "要接上真實後端時,請移除 VITE_AKENTROS_DEMO 設定,並確認 VITE_AKENTROS_API_BASE 指向 Worker。",
    ].join("\n"),
  };
}

function recordDemoUsage(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  chargedUsd: number,
  latencyMs: number,
) {
  state.logs.unshift(
    seedLog({
      requestId: `req_demo_${randomHex(12)}`,
      minutes: 0,
      model: modelId,
      status: "succeeded",
      inputTokens,
      outputTokens,
      chargedUsd: chargedUsd.toFixed(6),
      latencyMs,
    }),
  );
  state.balance_usd = Math.max(0, state.balance_usd - chargedUsd);
  const key = state.keys.find((item) => item.id === "key_demo_prod");
  if (key) key.last_used_at = new Date().toISOString();
}

async function streamDemoChat(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
  const modelId = typeof body.model === "string" && body.model ? body.model : "akentros/gpt-6-astra";
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const prompt = messages
    .map((message) =>
      typeof (message as { content?: unknown })?.content === "string"
        ? (message as { content: string }).content
        : "",
    )
    .join(" ");
  const { reasoning, content } = buildDemoReply(modelId, prompt);
  const startedAt = Date.now();

  if (body.stream !== true) {
    const outputTokens = Math.max(1, Math.round(Array.from(content).length / 2));
    const inputTokens = Math.max(1, Math.round(Array.from(prompt).length / 2));
    return json({
      id: `chatcmpl_demo_${randomHex(10)}`,
      object: "chat.completion",
      model: modelId,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      },
    });
  }

  return sseResponse(async (write) => {
    const sendDelta = (delta: Record<string, unknown>) => {
      write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    };

    // 依時間基準泵送:背景分頁的 setTimeout 會被瀏覽器嚴格節流,
    // 落後於排程時直接補送累積的區塊,讓串流無論前景背景都能準時完成。
    const pieces = [
      ...(reasoning ? chunkText(reasoning, 6).map((piece) => ({ delta: { reasoning: piece } })) : []),
      ...chunkText(content, 3).map((piece) => ({ delta: { content: piece } })),
    ];
    const intervalMs = 18;
    let pacedAt = Date.now();
    sendDelta({ role: "assistant", content: "" });
    for (const piece of pieces) {
      if (signal?.aborted) return;
      pacedAt += intervalMs;
      const waitMs = pacedAt - Date.now();
      if (waitMs > 0) await sleep(waitMs, signal);
      sendDelta(piece.delta);
    }
    if (signal?.aborted) return;

    const outputTokens = Math.max(1, Math.round(Array.from(content).length / 2));
    const inputTokens = Math.max(1, Math.round(Array.from(prompt).length / 2));
    const chargedUsd = Math.max(0.0001, Number((outputTokens * 0.0001).toFixed(6)));
    recordDemoUsage(modelId, inputTokens, outputTokens, chargedUsd, Date.now() - startedAt);

    write(
      `data: ${JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: inputTokens,
          completion_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
        },
      })}\n\n`,
    );
    write("data: [DONE]\n\n");
  }, signal);
}

// 示範模式的帳號系統:任意帳密皆可登入 DEMO_ACCOUNT;註冊則套用表單輸入。
async function handleAuthRequest(pathname: string, request: Request): Promise<Response> {
  const route = pathname.slice(AUTH_PREFIX.length) || "/";
  const method = request.method.toUpperCase();

  if (route === "/register" && method === "POST") {
    const body = await readJsonBody(request);
    const email =
      typeof body.email === "string" && body.email.trim()
        ? body.email.trim().toLowerCase()
        : DEMO_ACCOUNT.email;
    const username =
      typeof body.username === "string" && body.username.trim()
        ? body.username.trim().slice(0, 40)
        : DEMO_ACCOUNT.username;
    state.session = { ...DEMO_ACCOUNT, email, username };
    return json({ user: state.session }, 201);
  }

  if (route === "/login" && method === "POST") {
    const body = await readJsonBody(request);
    const email =
      typeof body.email === "string" && body.email.trim()
        ? body.email.trim().toLowerCase()
        : DEMO_ACCOUNT.email;
    state.session = { ...DEMO_ACCOUNT, email };
    return json({ user: state.session });
  }

  if (route === "/logout" && method === "POST") {
    state.session = null;
    return json({ ok: true });
  }

  if (route === "/me" && method === "GET") {
    if (!state.session) return errorJson("authentication_required", 401);
    return json({ user: state.session });
  }

  return errorJson("not_found", 404);
}

async function handlePublicChat(request: Request): Promise<Response> {
  const auth = request.headers.get("Authorization") ?? "";
  if (!/^Bearer sk-akentros-(live|test)_[A-Za-z0-9]{8,}$/.test(auth)) {
    return errorJson("invalid_api_key", 401);
  }
  const body = await readJsonBody(request);
  return streamDemoChat(body, request.signal);
}

async function handleDeveloperRequest(pathname: string, request: Request): Promise<Response> {
  const route = pathname.slice(DEVELOPER_PREFIX.length) || "/";
  const method = request.method.toUpperCase();

  if (route === "/keys" && method === "GET") {
    return json({ keys: state.keys });
  }

  if (route === "/keys" && method === "POST") {
    const body = await readJsonBody(request);
    const name =
      typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 80) : "Untitled key";
    const expiresAt = typeof body.expires_at === "string" ? body.expires_at : null;
    const spendLimitUsd =
      typeof body.spend_limit_usd === "string" && body.spend_limit_usd !== ""
        ? Number(body.spend_limit_usd).toFixed(6)
        : null;
    const replayTtl = Number(body.idempotency_replay_ttl_seconds);
    const secret = `sk-akentros-live_${randomHex(32)}`;
    const key: DemoApiKey = {
      id: `key_demo_${randomHex(8)}`,
      name,
      environment: "live",
      key_prefix: secret.slice(0, 18),
      key_suffix: secret.slice(-4),
      scopes: ["chat:completions", "models:read"],
      model_allowlist: null,
      is_active: true,
      last_used_at: null,
      expires_at: expiresAt,
      created_at: new Date().toISOString(),
      revoked_at: null,
      spend_limit_usd: spendLimitUsd,
      spend_used_usd: "0.000000",
      idempotency_replay_ttl_seconds:
        Number.isSafeInteger(replayTtl) && replayTtl > 0 && replayTtl <= 604800 ? replayTtl : 0,
    };
    state.keys.unshift(key);
    return json({ key, api_key: secret });
  }

  const rotateMatch = route.match(/^\/keys\/([^/]+)\/rotate$/);
  if (rotateMatch && method === "POST") {
    const key = state.keys.find((item) => item.id === decodeURIComponent(rotateMatch[1]));
    if (!key) return errorJson("AI_KEY_NOT_FOUND", 404);
    const secret = `sk-akentros-live_${randomHex(32)}`;
    key.key_prefix = secret.slice(0, 18);
    key.key_suffix = secret.slice(-4);
    return json({ key, api_key: secret });
  }

  const keyMatch = route.match(/^\/keys\/([^/]+)$/);
  if (keyMatch && method === "DELETE") {
    const id = decodeURIComponent(keyMatch[1]);
    const index = state.keys.findIndex((item) => item.id === id);
    if (index === -1) return errorJson("AI_KEY_NOT_FOUND", 404);
    state.keys.splice(index, 1);
    return new Response(null, { status: 204 });
  }

  if (route === "/usage/summary" && method === "GET") {
    return json({ usage: usageSummary() });
  }

  if (route === "/logs" && method === "GET") {
    const url = new URL(request.url);
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 25));
    const status = url.searchParams.get("status");
    const cursor = Number(url.searchParams.get("cursor")) || 0;
    const filtered = status ? state.logs.filter((log) => log.status === status) : state.logs;
    const page = filtered.slice(cursor, cursor + limit);
    const next = cursor + limit;
    return json({
      logs: page,
      pagination: {
        next_cursor: next < filtered.length ? String(next) : null,
        has_more: next < filtered.length,
      },
    });
  }

  const requestMatch = route.match(/^\/requests\/([^/]+)$/);
  if (requestMatch && method === "GET") {
    const log = state.logs.find((item) => item.request_id === decodeURIComponent(requestMatch[1]));
    if (!log) return errorJson("AI_REQUEST_NOT_FOUND", 404);
    return json({
      ...log,
      completed_at: log.created_at,
      pricing_revision: "2026-09-12.3",
      fallback_count: 0,
      first_token_latency_ms: log.latency_ms === null ? null : Math.round(log.latency_ms * 0.4),
    });
  }

  if (route === "/chat/completions" && method === "POST") {
    const body = await readJsonBody(request);
    return streamDemoChat(body, request.signal);
  }

  return errorJson("not_found", 404);
}

export function isAkentrosDemoMode(): boolean {
  if (import.meta.env.VITE_AKENTROS_DEMO === "1") return true;
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).has("demo");
}

// 開機當下判定一次:SPA 導航會掉掉 ?demo=1,但攔截器與標籤應整個 session 生效。
const demoActiveAtBoot = isAkentrosDemoMode();

export function isAkentrosDemoActive(): boolean {
  return demoActiveAtBoot;
}

export function installAkentrosDemoApi(): void {
  if (typeof window === "undefined") return;
  const host = window as typeof window & { __akentrosDemoInstalled?: boolean };
  if (host.__akentrosDemoInstalled) return;
  host.__akentrosDemoInstalled = true;

  // SPA 導航會把 ?demo=1 從網址拿掉;示範模式下永遠補回去,
  // 讓重新整理(F5)不會意外脫離示範模式。
  const keepDemoParam = (url: URL) => {
    if (!url.searchParams.has("demo")) {
      url.searchParams.set("demo", "1");
    }
    return url.toString();
  };
  const originalPushState = history.pushState.bind(history);
  history.pushState = (data, unused, url) => {
    const next = url == null ? null : keepDemoParam(new URL(String(url), window.location.href));
    return originalPushState(data, unused, next);
  };
  const originalReplaceState = history.replaceState.bind(history);
  history.replaceState = (data, unused, url) => {
    const next = url == null ? null : keepDemoParam(new URL(String(url), window.location.href));
    return originalReplaceState(data, unused, next);
  };

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let pathname: string;
    try {
      pathname = new URL(
        typeof input === "string" || input instanceof URL ? String(input) : input.url,
        window.location.origin,
      ).pathname;
    } catch {
      return originalFetch(input, init);
    }

    if (pathname === PUBLIC_CHAT_PATH) {
      return handlePublicChat(new Request(input, init));
    }
    if (pathname === AUTH_PREFIX || pathname.startsWith(`${AUTH_PREFIX}/`)) {
      return handleAuthRequest(pathname, new Request(input, init));
    }
    if (pathname === DEVELOPER_PREFIX || pathname.startsWith(`${DEVELOPER_PREFIX}/`)) {
      return handleDeveloperRequest(pathname, new Request(input, init));
    }
    return originalFetch(input, init);
  };
}
