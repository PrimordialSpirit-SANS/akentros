import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  listDiagnosticModels,
  parseDiagnosticOptions,
} from "../../../apps/gateway/scripts/providerDiagnostic.ts";

const scriptUrl = new URL("../../../apps/gateway/scripts/providerDiagnostic.ts", import.meta.url);

test("provider diagnostic is offline by default and exposes only public model IDs", () => {
  assert.deepEqual(parseDiagnosticOptions([]), {
    live: false,
    stream: false,
    all: false,
    requested: null,
    provider: "cloudflare-workers-ai",
  });
  const available = listDiagnosticModels();
  assert.ok(available.length > 0);
  assert.ok(available.every(({ publicModel }: any) => /^akentros\//.test(publicModel)));
  assert.ok(available.every(({ upstreamModel }: any) => /^@cf\//.test(upstreamModel)));
  assert.ok(available.every(({ route }: any) => route.provider === "cloudflare-workers-ai"));
});

test("QwenCloud diagnostics select its seven configured models without including Cloudflare routes", () => {
  const options = parseDiagnosticOptions(["--provider=qwencloud", "--all", "--stream"]);
  assert.equal(options.live, false);
  assert.equal(options.provider, "qwencloud");
  const available = listDiagnosticModels(options.provider);
  assert.deepEqual(
    available.map(({ upstreamModel }) => upstreamModel),
    [
      "deepseek-v4-pro-0813",
      "deepseek-v4.1-flash",
      "kimi-k3",
      "glm-5.3",
      "glm-5.3-flash",
      "qwen3.8-max",
      "qwen3.8-flash",
    ],
  );
  assert.ok(available.every(({ route }) => route.credential_pool === "qwencloud-production"));
});

test("provider diagnostic source requires an explicit live flag and never logs raw responses", () => {
  const source = readFileSync(scriptUrl, "utf8");
  assert.match(source, /args\.includes\(['"]--live['"]\)/);
  assert.match(source, /if \(!live\)/);
  assert.match(source, /path\.resolve\(process\.argv\[1\]\) === __filename/);
  assert.ok(source.indexOf("if (!live)") < source.indexOf("dotenv.config("));
  assert.doesNotMatch(source, /Account ID:|Response JSON:|statusText/);
});
