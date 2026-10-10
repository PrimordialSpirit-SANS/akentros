import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { load as loadYaml } from "js-yaml";

const specification: any = loadYaml(
  readFileSync(new URL("../../../docs/openapi.yaml", import.meta.url), "utf8"),
);

function resolveLocalRef(reference: string) {
  let value: any = specification;
  for (const encodedPart of reference.slice(2).split("/")) {
    const part = encodedPart.replaceAll("~1", "/").replaceAll("~0", "~");
    value = value?.[part];
  }
  return value;
}

function collectReferences(value: any, references: string[] = []): string[] {
  if (!value || typeof value !== "object") return references;
  if (typeof value.$ref === "string" && value.$ref.startsWith("#/")) {
    references.push(value.$ref);
  }
  for (const child of Object.values(value)) collectReferences(child, references);
  return references;
}

test("Akentros OpenAPI document parses and resolves every local reference", () => {
  assert.equal(specification.openapi, "3.1.0");
  const references = collectReferences(specification);
  assert.ok(references.length > 0);
  assert.deepEqual(
    [...new Set(references.filter((reference) => resolveLocalRef(reference) === undefined))],
    [],
  );
});

test("inference and developer surfaces keep separate authentication contracts", () => {
  for (const path of ["/api/ai/v1/models", "/api/ai/v1/chat/completions", "/api/ai/v1/embeddings"]) {
    const operation: any = Object.values(specification.paths[path])[0];
    assert.deepEqual(operation.security, [{ AkentrosKey: [] }]);
  }
  const developerPaths = Object.entries(specification.paths).filter(([path]) =>
    path.startsWith("/api/ai/developer/"),
  );
  // SN-3 fix:developer management authentication is cookie-only; the
  // previously advertised (never implemented) SessionBearer scheme was removed.
  // SN-16 fix: the Playground account-mode chat endpoint is now declared too.
  assert.equal(developerPaths.length, 7);
  for (const [, pathItem] of developerPaths) {
    for (const operation of Object.values(pathItem as Record<string, any>)) {
      if ((operation as any).security) {
        assert.deepEqual((operation as any).security, [{ SessionCookie: [] }]);
      }
    }
  }
  assert.equal("SessionBearer" in specification.components.securitySchemes, false);
});

// ECO-04 P1:公開推理面「支援哪些 OpenAI 端點」以契約釘死,防止未來
// 無聲漂移 —— 路徑集新增或移除端點時,此測試與 README 相容性矩陣必須
// 同步更新,遷移者永遠有一份權威清單可查。
const EXPECTED_PUBLIC_INFERENCE_PATHS = [
  "/api/ai/v1/models",
  "/api/ai/v1/chat/completions",
  "/api/ai/v1/embeddings",
];

test("the public inference surface exposes exactly the documented endpoints", () => {
  const publicPaths = Object.keys(specification.paths).filter((path) => path.startsWith("/api/ai/v1/"));
  assert.deepEqual(publicPaths, EXPECTED_PUBLIC_INFERENCE_PATHS);
  // 契約描述必須載明不支援的 OpenAI 端點,與 README 相容性矩陣一致。
  const description: string = specification.info.description;
  for (const endpoint of EXPECTED_PUBLIC_INFERENCE_PATHS) {
    assert.ok(description.includes(endpoint), `${endpoint} missing from info.description`);
  }
  for (const unsupported of [
    "/responses",
    "/audio",
    "/images",
    "/moderations",
    "/files",
    "/batches",
    "/realtime",
    "legacy /completions",
  ]) {
    assert.ok(
      description.includes(unsupported),
      `info.description must explicitly list ${unsupported} as unsupported`,
    );
  }
});

test("API key secrets are confined to create and rotate mutation responses", () => {
  const schemas = specification.components.schemas;
  assert.equal("api_key" in schemas.ApiKeyMetadata.properties, false);
  assert.equal(schemas.ApiKeyMutationResult.properties.api_key.type, "string");
  assert.ok(specification.paths["/api/ai/developer/keys"].post.responses["201"]);
  assert.ok(specification.paths["/api/ai/developer/keys/{id}/rotate"].post.responses["200"]);
  assert.ok(specification.paths["/api/ai/developer/keys/{id}"].delete.responses["204"]);
});

test("chat contracts reject undeclared routing controls while preserving public thinking control", () => {
  const schemas = specification.components.schemas;
  const request = schemas.ChatCompletionRequest;
  assert.equal(request.additionalProperties, false);
  assert.equal(schemas.ChatMessage.additionalProperties, false);
  assert.equal(schemas.ChatTool.additionalProperties, false);
  assert.equal(schemas.FunctionDefinition.additionalProperties, false);
  assert.equal(schemas.ToolCall.additionalProperties, false);
  assert.equal(schemas.ToolCall.properties.function.additionalProperties, false);
  assert.equal(request.properties.stream_options.additionalProperties, false);
  assert.equal(request.properties.chat_template_kwargs.additionalProperties, false);
  assert.equal(request.properties.chat_template_kwargs.properties.thinking.type, "boolean");
  assert.deepEqual(Object.keys(request.properties).sort(), [
    "chat_template_kwargs",
    "frequency_penalty",
    "max_completion_tokens",
    "max_tokens",
    "messages",
    "model",
    "n",
    "presence_penalty",
    "response_format",
    "seed",
    "stop",
    "stream",
    "stream_options",
    "temperature",
    "tool_choice",
    "tools",
    "top_p",
  ]);
  // ECO-01:response_format 契約為分型 oneOf(text / json_object / json_schema)，
  // 能力閘門的描述必須同時在 description 與各分支的 const 上可判讀。
  assert.equal(request.properties.response_format.oneOf.length, 3);
  assert.deepEqual(
    request.properties.response_format.oneOf.map((branch: any) => branch.properties.type.const),
    ["text", "json_object", "json_schema"],
  );
  assert.match(request.properties.response_format.description, /json_mode/);
  assert.match(request.properties.response_format.description, /structured_outputs/);
  for (const internalField of ["provider", "route", "transforms", "upstream_model"]) {
    assert.equal(internalField in request.properties, false);
  }

  const response = schemas.ChatCompletionResponse;
  assert.equal(response.additionalProperties, false);
  assert.equal(response.properties.choices.items.additionalProperties, false);
  assert.equal(response.properties.choices.items.properties.message.additionalProperties, false);
  assert.ok(response.properties.choices.items.properties.message.properties.tool_calls);
  assert.ok(request.properties.messages.items.$ref);
  assert.equal(schemas.TokenUsage.additionalProperties, false);
});

test("developer usage contracts preserve shape with Akentros-owned neutral metadata", () => {
  const schemas = specification.components.schemas;
  assert.equal(schemas.UsageSummary.additionalProperties, false);
  assert.ok(schemas.UsageSummary.required.includes("free_model_quotas"));
  assert.equal(
    schemas.UsageSummary.properties.free_model_quotas.additionalProperties.$ref,
    "#/components/schemas/FreeModelQuota",
  );
  assert.deepEqual(schemas.FreeModelQuota.required, ["used", "limit"]);
  const usage = schemas.UsageLog;
  assert.equal(usage.additionalProperties, false);
  assert.equal(usage.properties.provider.const, "akentros");
  assert.equal(usage.properties.provider.type, "string");
  assert.match(usage.properties.actual_model.description, /mirrors requested_model/i);
  assert.match(usage.properties.error_code.description, /internal execution codes are never returned/i);

  const detailExtension = schemas.RequestDetail.allOf.find((entry: any) => entry.properties);
  assert.equal(detailExtension, undefined);
  assert.deepEqual(schemas.RequestDetail.allOf.at(-1).required, ["pricing_revision"]);
  assert.equal(usage.properties.pricing_revision.type[0], "string");
  assert.doesNotMatch(JSON.stringify(schemas.RequestDetail), /upstream|fallback/i);
  assert.equal(schemas.RequestDetail.unevaluatedProperties, false);

  const publicError = schemas.OpenAiErrorEnvelope;
  assert.equal(publicError.additionalProperties, false);
  assert.equal(publicError.properties.error.additionalProperties, false);
  assert.match(
    publicError.properties.error.properties.code.description,
    /internal execution codes are never returned/i,
  );

  const completionResponses = specification.paths["/api/ai/v1/chat/completions"].post.responses;
  assert.ok(completionResponses["403"], "native Akentros authorization failures remain documented");
  assert.ok(completionResponses["408"], "Akentros request cancellation remains documented");
  assert.ok(completionResponses["503"], "normalized Akentros availability failures remain documented");
  assert.equal(completionResponses["502"], undefined);
  assert.equal(completionResponses["504"], undefined);
});

test("Standalone gateway mounts the Hono app and documents every provider secret binding", () => {
  const gatewayApp = readFileSync(new URL("../../../apps/gateway/src/app.ts", import.meta.url), "utf8");
  assert.match(gatewayApp, /app\.route\(['"]\/api\/ai\/v1['"],\s*aiPublicRoutes\)/);

  const pools = JSON.parse(
    readFileSync(new URL("../config/provider-pools.v1.json", import.meta.url), "utf8"),
  );
  const requiredBindings = Object.values(pools.pools).flatMap((pool: any) =>
    pool.credentials.flatMap((credential: any) => Object.values(credential.secret_refs)),
  );
  const example = readFileSync(new URL("../../../apps/gateway/.dev.vars.example", import.meta.url), "utf8");
  assert.match(example, /AKENTROS_API_KEY_PEPPER/);
  for (const binding of requiredBindings) assert.match(example, new RegExp(binding));
});
