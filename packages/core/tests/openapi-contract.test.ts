import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import yaml from "js-yaml";

const specification: any = yaml.load(
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

test("Beacon OpenAPI document parses and resolves every local reference", () => {
  assert.equal(specification.openapi, "3.1.0");
  const references = collectReferences(specification);
  assert.ok(references.length > 0);
  assert.deepEqual(
    [...new Set(references.filter((reference) => resolveLocalRef(reference) === undefined))],
    [],
  );
});

test("inference and developer surfaces keep separate authentication contracts", () => {
  for (const path of ["/api/ai/v1/models", "/api/ai/v1/chat/completions"]) {
    const operation: any = Object.values(specification.paths[path])[0];
    assert.deepEqual(operation.security, [{ BeaconKey: [] }]);
  }

  const developerPaths = Object.entries(specification.paths).filter(([path]) =>
    path.startsWith("/api/ai/developer/"),
  );
  assert.equal(developerPaths.length, 6);
  for (const [, pathItem] of developerPaths) {
    for (const operation of Object.values(pathItem as Record<string, any>)) {
      assert.deepEqual(operation.security, [{ SessionBearer: [] }, { SessionCookie: [] }]);
    }
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
    "seed",
    "stop",
    "stream",
    "stream_options",
    "temperature",
    "tool_choice",
    "tools",
    "top_p",
  ]);
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

test("developer usage contracts preserve shape with Beacon-owned neutral metadata", () => {
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
  assert.equal(usage.properties.provider.const, "beacon");
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
  assert.ok(completionResponses["403"], "native Beacon authorization failures remain documented");
  assert.ok(completionResponses["408"], "Beacon request cancellation remains documented");
  assert.ok(completionResponses["503"], "normalized Beacon availability failures remain documented");
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
  assert.match(example, /BEACON_API_KEY_PEPPER/);
  for (const binding of requiredBindings) assert.match(example, new RegExp(binding));
});
