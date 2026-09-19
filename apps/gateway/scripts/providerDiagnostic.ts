import path from "node:path";
import { fileURLToPath } from "node:url";
import { listEnabledModels } from "@akentros/core/pricing";
import {
  AkentrosProviderError,
  invokeProviderRoute,
  listEnabledCredentials,
  normalizeProviderUsage,
  requireProviderPool,
  resolveProviderCredential,
} from "@akentros/core/providers";
import { parseSseStream } from "@akentros/core/sse";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TIMEOUT_MS = 30_000;

export function listDiagnosticModels(provider = "cloudflare-workers-ai") {
  return listEnabledModels()
    .flatMap((model) =>
      (model.routes || [])
        .filter((route: any) => route?.enabled === true && route.provider === provider)
        .map((route: any) => ({ publicModel: model.id, upstreamModel: route.upstream_model, route })),
    )
    .filter(
      (item, index, items) =>
        items.findIndex((candidate) => candidate.publicModel === item.publicModel) === index,
    );
}

function option(name: any, args: any) {
  const prefix = `--${name}=`;
  return args.find((value: any) => value.startsWith(prefix))?.slice(prefix.length) || null;
}

export function parseDiagnosticOptions(args: string[] = []) {
  return {
    live: args.includes("--live"),
    stream: args.includes("--stream"),
    all: args.includes("--all"),
    requested: option("model", args),
    provider: option("provider", args) || "cloudflare-workers-ai",
  };
}

function usage(payload: any) {
  return normalizeProviderUsage(payload?.usage) || normalizeProviderUsage(payload?.result?.usage) || null;
}

async function inspectStream(response: any) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("text/event-stream") || !response.body) {
    await response.body?.cancel().catch(() => {});
    return { result: "invalid_stream_response", usage_reported: false, done_reported: false };
  }
  let eventCount = 0;
  let invalidEvents = 0;
  let usageReported = false;
  let doneReported = false;
  for await (const event of parseSseStream(response.body)) {
    if (event.data === "[DONE]") {
      doneReported = true;
      break;
    }
    eventCount += 1;
    try {
      if (usage(JSON.parse(event.data))) usageReported = true;
    } catch {
      invalidEvents += 1;
    }
  }
  return {
    result: doneReported && invalidEvents === 0 ? "ok" : "incomplete_stream",
    usage_reported: usageReported,
    done_reported: doneReported,
    event_count: eventCount,
    invalid_event_count: invalidEvents,
  };
}

async function probe(candidate: any, env: Record<string, string | undefined>, stream: boolean) {
  let result: any;
  try {
    const pool = requireProviderPool(candidate.route.credential_pool);
    const credential = listEnabledCredentials(pool).find((entry: any) =>
      Object.values(entry.secret_refs).every((reference) => env[String(reference)]?.trim()),
    );
    if (!credential) return { result: "credential_not_configured" };
    result = await invokeProviderRoute({
      route: { ...candidate.route, timeout_ms: Math.min(candidate.route.timeout_ms, TIMEOUT_MS) },
      pool,
      credential: resolveProviderCredential(pool, credential, env),
      body: {
        model: candidate.publicModel,
        messages: [{ role: "user", content: "Reply with OK." }],
        max_completion_tokens: candidate.route.provider === "qwencloud" ? 512 : 8,
        stream,
      },
    });
    if (result.stream !== stream) {
      await result.response?.body?.cancel().catch(() => {});
      return { result: "protocol_mismatch" };
    }
    if (stream) return await inspectStream(result.response);
    return { result: "ok", usage_reported: result.usageSource === "provider" };
  } catch (error: any) {
    return {
      result: error instanceof AkentrosProviderError ? error.category : "diagnostic_error",
    };
  } finally {
    result?.dispose?.();
  }
}

async function main(args = process.argv.slice(2)) {
  const { live, stream, all, requested, provider } = parseDiagnosticOptions(args);
  const available = listDiagnosticModels(provider);

  if (!live) {
    console.log(
      JSON.stringify(
        {
          mode: "dry_run",
          live_request_sent: false,
          available_public_models: available.map((item) => item.publicModel),
          usage:
            "Add --live with --model=<public-model> or --all; add --provider=<provider id> (e.g. qwencloud, openai, anthropic, google, xai, groq) and --stream for SSE.",
        },
        null,
        2,
      ),
    );
    return;
  }
  if (!all && !requested) throw new Error("Live diagnostics require --model=<public-model> or --all.");

  const selected = all ? available : available.filter((item) => item.publicModel === requested);
  if (selected.length === 0) throw new Error("The requested public Akentros model is unavailable.");
  dotenv.config({ path: path.join(__dirname, "../.dev.vars"), quiet: true });

  for (const candidate of selected) {
    const result = await probe(candidate, process.env, stream);
    console.log(
      JSON.stringify({
        public_model: candidate.publicModel,
        mode: stream ? "stream" : "json",
        ...result,
      }),
    );
    if (result.result !== "ok") process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((error: any) => {
    console.error(JSON.stringify({ result: "diagnostic_failed", message: error.message }));
    process.exitCode = 1;
  });
}
