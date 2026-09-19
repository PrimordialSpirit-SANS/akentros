import type { AkentrosBrandManifest, AkentrosModelsCatalog, AkentrosProviderOfferingsCatalog } from "../types";

const CATALOG_ROOT = "/data/akentros";
const BRAND_MANIFEST_PATH = "/brand/akentros/providers/manifest.v1.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertBaseCatalog(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!isRecord(value) || value.schema_version !== 1) {
    throw new Error(`${label} 格式版本不受支援。`);
  }
}

async function fetchStaticJson(path: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(path, {
    signal,
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`載入 ${path} 失敗（HTTP ${response.status}）。`);
  }
  return response.json() as Promise<unknown>;
}

export async function loadAkentrosModels(signal?: AbortSignal): Promise<AkentrosModelsCatalog> {
  const value = await fetchStaticJson(`${CATALOG_ROOT}/models.v1.json`, signal);
  assertBaseCatalog(value, "模型目錄");
  if (
    typeof value.pricing_revision !== "string" ||
    typeof value.updated_at !== "string" ||
    !Array.isArray(value.models) ||
    value.models.some((model) => !isRecord(model) || typeof model.id !== "string")
  ) {
    throw new Error("模型目錄缺少必要欄位。");
  }
  return value as unknown as AkentrosModelsCatalog;
}

export async function loadAkentrosProviderOfferings(
  signal?: AbortSignal,
): Promise<AkentrosProviderOfferingsCatalog> {
  const value = await fetchStaticJson(`${CATALOG_ROOT}/provider-offerings.v1.json`, signal);
  assertBaseCatalog(value, "供應與價格目錄");
  if (
    typeof value.pricing_revision !== "string" ||
    value.currency !== "akentros_point" ||
    value.billing_unit !== "per_million_tokens" ||
    !Array.isArray(value.offerings) ||
    value.offerings.some((offering) => !isRecord(offering) || typeof offering.id !== "string")
  ) {
    throw new Error("供應與價格目錄缺少必要欄位。");
  }
  return value as unknown as AkentrosProviderOfferingsCatalog;
}

export async function loadAkentrosBrandManifest(signal?: AbortSignal): Promise<AkentrosBrandManifest> {
  const value = await fetchStaticJson(BRAND_MANIFEST_PATH, signal);
  assertBaseCatalog(value, "品牌資產 manifest");
  if (
    !Array.isArray(value.assets) ||
    value.assets.some((asset) => !isRecord(asset) || typeof asset.id !== "string")
  ) {
    throw new Error("品牌資產 manifest 缺少必要欄位。");
  }
  return value as unknown as AkentrosBrandManifest;
}
