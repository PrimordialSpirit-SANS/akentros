export interface AkentrosConfigValidationError extends Error {
  validationErrors: string[];
}

const REVISION = /^[0-9]{4}-[0-9]{2}-[0-9]{2}\.[1-9][0-9]*$/;
const _DECIMAL = /^(0|[1-9][0-9]*)$/;
const USD_DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/;
const _POSITIVE_DECIMAL = /^[1-9][0-9]*$/;
const MODEL_ID = /^akentros\/[a-z0-9][a-z0-9._-]+$/;
const INTERNAL_ID = /^[a-z0-9][a-z0-9.-]{2,79}$/;
const ENV_REFERENCE = /^[A-Z][A-Z0-9_]{2,127}$/;
const PROVIDER_API_STYLES = new Map([
  ["openrouter", "openai-compatible"],
  ["cloudflare-workers-ai", "cloudflare-rest"],
  ["hugging-face", "openai-compatible"],
  ["qwencloud", "openai-compatible"],
  ["openai", "openai-compatible"],
  ["anthropic", "anthropic-messages"],
  ["google", "openai-compatible"],
  ["xai", "openai-compatible"],
  ["groq", "openai-compatible"],
  ["mistral", "openai-compatible"],
  ["deepseek", "openai-compatible"],
  ["together", "openai-compatible"],
  ["fireworks", "openai-compatible"],
  ["cerebras", "openai-compatible"],
  ["perplexity", "openai-compatible"],
  ["cohere", "openai-compatible"],
  ["moonshot", "openai-compatible"],
  ["zhipu", "openai-compatible"],
  ["minimax", "openai-compatible"],
  ["nvidia", "openai-compatible"],
  ["deepinfra", "openai-compatible"],
  ["sambanova", "openai-compatible"],
  ["lambda", "openai-compatible"],
  ["friendli", "openai-compatible"],
  ["baichuan", "openai-compatible"],
  ["stepfun", "openai-compatible"],
  ["hunyuan", "openai-compatible"],
  ["spark", "openai-compatible"],
  ["ernie", "openai-compatible"],
  ["ai21", "openai-compatible"],
  ["amazon-bedrock", "openai-compatible"],
  ["azure-openai", "openai-compatible"],
  ["scaleway", "openai-compatible"],
  ["ovhcloud", "openai-compatible"],
  ["custom", "openai-compatible"],
]);
const PROVIDERS = new Set(PROVIDER_API_STYLES.keys());
const API_STYLES = new Set(PROVIDER_API_STYLES.values());

function isObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function push(errors: string[], condition: boolean, path: string, message: string) {
  if (!condition) errors.push(`${path}: ${message}`);
}

function hasExactKeys(
  errors: string[],
  value: unknown,
  path: string,
  required: string[],
  optional: string[] = [],
) {
  if (!isObject(value)) {
    errors.push(`${path}: expected an object`);
    return false;
  }
  for (const key of required) push(errors, key in value, `${path}.${key}`, "is required");
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) push(errors, allowed.has(key), `${path}.${key}`, "is not allowed");
  return true;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isDateTime(value: unknown) {
  return (
    typeof value === "string" &&
    /(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function result(errors: string[]) {
  return { valid: errors.length === 0, errors };
}

function assertionError(label: string, validation: { errors: string[] }) {
  const error = new Error(
    `${label} validation failed:\n${validation.errors.join("\n")}`,
  ) as AkentrosConfigValidationError;
  error.name = "AkentrosConfigValidationError";
  error.validationErrors = validation.errors;
  return error;
}

export function validateBackendPricing(config: Record<string, any>) {
  const errors: string[] = [];
  const rootKeys = ["schema_version", "revision", "published_at", "effective_at", "currency", "models"];
  if (!hasExactKeys(errors, config, "$", rootKeys)) return result(errors);

  push(errors, config.schema_version === "1.0.0", "$.schema_version", "must equal 1.0.0");
  push(
    errors,
    typeof config.revision === "string" && REVISION.test(config.revision),
    "$.revision",
    "has an invalid revision",
  );
  push(errors, isDateTime(config.published_at), "$.published_at", "must be an RFC 3339 date-time");
  push(errors, isDateTime(config.effective_at), "$.effective_at", "must be an RFC 3339 date-time");

  if (hasExactKeys(errors, config.currency, "$.currency", ["code", "settlement_unit", "micros_per_usd"])) {
    push(errors, config.currency.code === "USD", "$.currency.code", "must equal USD");
    push(
      errors,
      config.currency.settlement_unit === "usd_micros",
      "$.currency.settlement_unit",
      "must equal usd_micros",
    );
    push(
      errors,
      config.currency.micros_per_usd === 1000000,
      "$.currency.micros_per_usd",
      "must equal 1000000",
    );
  }

  if (!isObject(config.models) || Object.keys(config.models).length === 0) {
    errors.push("$.models: expected at least one model");
    return result(errors);
  }

  const routeIds = new Set<string>();
  for (const [modelId, model] of Object.entries(config.models) as Array<[string, Record<string, any>]>) {
    const path = `$.models.${modelId}`;
    push(errors, MODEL_ID.test(modelId), path, "has an invalid public model ID");
    const modelKeys = [
      "object",
      "enabled",
      "display_name",
      "owned_by",
      "capabilities",
      "billing",
      "limits",
      "routes",
    ];
    if (!hasExactKeys(errors, model, path, modelKeys)) continue;
    push(errors, model.object === "model", `${path}.object`, "must equal model");
    push(errors, typeof model.enabled === "boolean", `${path}.enabled`, "must be boolean");
    push(
      errors,
      typeof model.display_name === "string" &&
        model.display_name.length > 0 &&
        model.display_name.length <= 120,
      `${path}.display_name`,
      "must contain 1-120 characters",
    );
    push(errors, model.owned_by === "akentros", `${path}.owned_by`, "must equal akentros");

    const capabilityKeys = ["chat_completions", "streaming", "tools", "json_mode", "vision"];
    if (hasExactKeys(errors, model.capabilities, `${path}.capabilities`, capabilityKeys)) {
      for (const key of capabilityKeys)
        push(
          errors,
          typeof model.capabilities[key] === "boolean",
          `${path}.capabilities.${key}`,
          "must be boolean",
        );
    }

    const billingKeys = [
      "input_usd_per_million_tokens",
      "output_usd_per_million_tokens",
      "minimum_charge_usd",
    ];
    if (hasExactKeys(errors, model.billing, `${path}.billing`, billingKeys)) {
      push(
        errors,
        typeof model.billing.input_usd_per_million_tokens === "string" &&
          USD_DECIMAL.test(model.billing.input_usd_per_million_tokens),
        `${path}.billing.input_usd_per_million_tokens`,
        "must be a USD decimal string with at most 6 fractional digits",
      );
      push(
        errors,
        typeof model.billing.output_usd_per_million_tokens === "string" &&
          USD_DECIMAL.test(model.billing.output_usd_per_million_tokens),
        `${path}.billing.output_usd_per_million_tokens`,
        "must be a USD decimal string with at most 6 fractional digits",
      );
      push(
        errors,
        typeof model.billing.minimum_charge_usd === "string" &&
          USD_DECIMAL.test(model.billing.minimum_charge_usd),
        `${path}.billing.minimum_charge_usd`,
        "must be a USD decimal string with at most 6 fractional digits",
      );
    }

    const limitKeys = [
      "context_tokens",
      "max_input_tokens",
      "default_max_completion_tokens",
      "max_completion_tokens",
    ];
    if (hasExactKeys(errors, model.limits, `${path}.limits`, limitKeys)) {
      for (const key of limitKeys)
        push(
          errors,
          isPositiveInteger(model.limits[key]),
          `${path}.limits.${key}`,
          "must be a positive safe integer",
        );
      if (limitKeys.every((key) => isPositiveInteger(model.limits[key]))) {
        push(
          errors,
          model.limits.default_max_completion_tokens <= model.limits.max_completion_tokens,
          `${path}.limits`,
          "default output limit exceeds maximum",
        );
        push(
          errors,
          model.limits.max_input_tokens + model.limits.max_completion_tokens <= model.limits.context_tokens,
          `${path}.limits`,
          "input plus maximum output exceeds context",
        );
      }
    }

    if (!Array.isArray(model.routes) || model.routes.length === 0) {
      errors.push(`${path}.routes: expected at least one route`);
      continue;
    }
    let enabledRoutes = 0;
    for (const [index, route] of model.routes.entries()) {
      const routePath = `${path}.routes[${index}]`;
      const routeKeys = [
        "route_id",
        "provider",
        "credential_pool",
        "upstream_model",
        "priority",
        "timeout_ms",
        "enabled",
      ];
      if (!hasExactKeys(errors, route, routePath, routeKeys)) continue;
      push(
        errors,
        typeof route.route_id === "string" && INTERNAL_ID.test(route.route_id),
        `${routePath}.route_id`,
        "has an invalid route ID",
      );
      if (routeIds.has(route.route_id)) errors.push(`${routePath}.route_id: duplicates another route ID`);
      else routeIds.add(route.route_id);
      push(errors, PROVIDERS.has(route.provider), `${routePath}.provider`, "is unsupported");
      push(
        errors,
        typeof route.credential_pool === "string" && INTERNAL_ID.test(route.credential_pool),
        `${routePath}.credential_pool`,
        "has an invalid pool ID",
      );
      push(
        errors,
        typeof route.upstream_model === "string" &&
          route.upstream_model.length > 0 &&
          route.upstream_model.length <= 200,
        `${routePath}.upstream_model`,
        "must contain 1-200 characters",
      );
      push(
        errors,
        isNonNegativeInteger(route.priority) && route.priority <= 10000,
        `${routePath}.priority`,
        "must be an integer from 0 to 10000",
      );
      push(
        errors,
        isPositiveInteger(route.timeout_ms) && route.timeout_ms >= 1000 && route.timeout_ms <= 300000,
        `${routePath}.timeout_ms`,
        "must be an integer from 1000 to 300000",
      );
      push(errors, typeof route.enabled === "boolean", `${routePath}.enabled`, "must be boolean");
      if (route.enabled === true) enabledRoutes += 1;
    }
    if (model.enabled === true)
      push(errors, enabledRoutes > 0, `${path}.routes`, "enabled models need an enabled route");
  }

  return result(errors);
}

export function assertValidBackendPricing(config: Record<string, any>) {
  const validation = validateBackendPricing(config);
  if (!validation.valid) throw assertionError("Backend pricing", validation);
  return config;
}

export function validateProviderPools(config: Record<string, any>) {
  const errors: string[] = [];
  if (!hasExactKeys(errors, config, "$", ["schema_version", "revision", "pools"])) return result(errors);
  push(errors, config.schema_version === "1.0.0", "$.schema_version", "must equal 1.0.0");
  push(
    errors,
    typeof config.revision === "string" && REVISION.test(config.revision),
    "$.revision",
    "has an invalid revision",
  );
  if (!isObject(config.pools) || Object.keys(config.pools).length === 0) {
    errors.push("$.pools: expected at least one pool");
    return result(errors);
  }

  const credentialIds = new Set<string>();
  for (const [poolId, pool] of Object.entries(config.pools) as Array<[string, Record<string, any>]>) {
    const path = `$.pools.${poolId}`;
    push(errors, INTERNAL_ID.test(poolId), path, "has an invalid pool ID");
    const poolKeys = ["provider", "enabled", "api_style", "base_url", "selection", "credentials"];
    if (!hasExactKeys(errors, pool, path, poolKeys)) continue;
    push(errors, PROVIDERS.has(pool.provider), `${path}.provider`, "is unsupported");
    push(errors, typeof pool.enabled === "boolean", `${path}.enabled`, "must be boolean");
    push(errors, API_STYLES.has(pool.api_style), `${path}.api_style`, "is unsupported");
    const expectedApiStyle = PROVIDER_API_STYLES.get(pool.provider);
    if (expectedApiStyle && API_STYLES.has(pool.api_style)) {
      push(
        errors,
        pool.api_style === expectedApiStyle,
        `${path}.api_style`,
        `must equal ${expectedApiStyle} for provider ${pool.provider}`,
      );
    }
    push(
      errors,
      typeof pool.base_url === "string" &&
        /^https:\/\/[^\s]+$/.test(pool.base_url) &&
        pool.base_url.length <= 500,
      `${path}.base_url`,
      "must be an HTTPS URL",
    );

    const selectionKeys = ["strategy", "lease_ttl_ms", "base_cooldown_ms", "max_cooldown_ms"];
    if (hasExactKeys(errors, pool.selection, `${path}.selection`, selectionKeys)) {
      push(
        errors,
        pool.selection.strategy === "database-weighted-round-robin",
        `${path}.selection.strategy`,
        "must use database-weighted-round-robin",
      );
      for (const key of selectionKeys.slice(1))
        push(
          errors,
          isPositiveInteger(pool.selection[key]),
          `${path}.selection.${key}`,
          "must be a positive safe integer",
        );
      if (
        isPositiveInteger(pool.selection.base_cooldown_ms) &&
        isPositiveInteger(pool.selection.max_cooldown_ms)
      ) {
        push(
          errors,
          pool.selection.base_cooldown_ms <= pool.selection.max_cooldown_ms,
          `${path}.selection`,
          "base cooldown exceeds maximum",
        );
      }
    }

    if (!Array.isArray(pool.credentials) || pool.credentials.length === 0) {
      errors.push(`${path}.credentials: expected at least one credential reference`);
      continue;
    }
    let enabledCredentials = 0;
    for (const [index, credential] of pool.credentials.entries()) {
      const credentialPath = `${path}.credentials[${index}]`;
      const credentialKeys = ["credential_id", "enabled", "weight", "max_in_flight", "secret_refs"];
      if (!hasExactKeys(errors, credential, credentialPath, credentialKeys)) continue;
      push(
        errors,
        typeof credential.credential_id === "string" && INTERNAL_ID.test(credential.credential_id),
        `${credentialPath}.credential_id`,
        "has an invalid credential ID",
      );
      if (credentialIds.has(credential.credential_id))
        errors.push(`${credentialPath}.credential_id: duplicates another credential ID`);
      else credentialIds.add(credential.credential_id);
      push(errors, typeof credential.enabled === "boolean", `${credentialPath}.enabled`, "must be boolean");
      push(
        errors,
        isPositiveInteger(credential.weight) && credential.weight <= 10000,
        `${credentialPath}.weight`,
        "must be an integer from 1 to 10000",
      );
      push(
        errors,
        isPositiveInteger(credential.max_in_flight) && credential.max_in_flight <= 10000,
        `${credentialPath}.max_in_flight`,
        "must be an integer from 1 to 10000",
      );
      if (credential.enabled === true) enabledCredentials += 1;

      const requiredRefs =
        pool.provider === "cloudflare-workers-ai" ? ["api_token", "account_id"] : ["api_key"];
      if (hasExactKeys(errors, credential.secret_refs, `${credentialPath}.secret_refs`, requiredRefs)) {
        for (const key of requiredRefs)
          push(
            errors,
            typeof credential.secret_refs[key] === "string" &&
              ENV_REFERENCE.test(credential.secret_refs[key]),
            `${credentialPath}.secret_refs.${key}`,
            "must be an environment binding name",
          );
      }
    }
    if (pool.enabled === true)
      push(errors, enabledCredentials > 0, `${path}.credentials`, "enabled pools need an enabled credential");
  }

  return result(errors);
}

export function assertValidProviderPools(config: Record<string, any>) {
  const validation = validateProviderPools(config);
  if (!validation.valid) throw assertionError("Provider pool", validation);
  return config;
}

export function validateConfigBundle(pricing: Record<string, any>, pools: Record<string, any>) {
  const pricingValidation = validateBackendPricing(pricing);
  const poolValidation = validateProviderPools(pools);
  const errors = [
    ...pricingValidation.errors.map((error) => `pricing ${error}`),
    ...poolValidation.errors.map((error) => `pools ${error}`),
  ];
  if (!pricingValidation.valid || !poolValidation.valid) return result(errors);
  push(
    errors,
    pricing.revision === pools.revision,
    "$.revision",
    "pricing and provider pool revisions must match",
  );

  for (const [modelId, model] of Object.entries(pricing.models) as Array<[string, Record<string, any>]>) {
    for (const route of model.routes) {
      const path = `$.models.${modelId}.routes.${route.route_id}`;
      const pool = pools.pools[route.credential_pool];
      push(errors, Boolean(pool), `${path}.credential_pool`, "references a missing provider pool");
      if (!pool) continue;
      push(errors, pool.provider === route.provider, `${path}.provider`, "does not match its provider pool");
      if (model.enabled && route.enabled) {
        push(errors, pool.enabled === true, `${path}.credential_pool`, "references a disabled provider pool");
        push(
          errors,
          pool.credentials.some((credential: any) => credential.enabled === true),
          `${path}.credential_pool`,
          "has no enabled credential",
        );
      }
    }
  }
  return result(errors);
}

export function assertValidConfigBundle(pricing: Record<string, any>, pools: Record<string, any>) {
  const validation = validateConfigBundle(pricing, pools);
  if (!validation.valid) throw assertionError("Akentros config bundle", validation);
  return { pricing, pools };
}
