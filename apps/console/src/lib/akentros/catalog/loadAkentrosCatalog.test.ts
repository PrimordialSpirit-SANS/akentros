import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadAkentrosBrandManifest,
  loadAkentrosModels,
  loadAkentrosProviderOfferings,
} from "./loadAkentrosCatalog";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadAkentrosModels", () => {
  it("returns a valid catalog", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        schema_version: 1,
        pricing_revision: "rev-1",
        updated_at: "2026-01-01",
        models: [{ id: "akentros-mini" }],
      }),
    );
    const catalog = await loadAkentrosModels();
    expect(catalog.pricing_revision).toBe("rev-1");
    expect(catalog.models).toHaveLength(1);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/data/akentros/models.v1.json",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("rejects unsupported schema versions", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, { schema_version: 2 }));
    await expect(loadAkentrosModels()).rejects.toThrow("格式版本不受支援");
  });

  it("rejects catalogs with missing required fields", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { schema_version: 1, models: [{ name: "no-id" }] }),
    );
    await expect(loadAkentrosModels()).rejects.toThrow("缺少必要欄位");
  });

  it("surfaces HTTP failures with the status code", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(404, {}));
    await expect(loadAkentrosModels()).rejects.toThrow("HTTP 404");
  });
});

describe("loadAkentrosProviderOfferings", () => {
  it("requires akentros_point currency and per million tokens billing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        schema_version: 1,
        pricing_revision: "rev-1",
        currency: "usd",
        billing_unit: "per_million_tokens",
        offerings: [],
      }),
    );
    await expect(loadAkentrosProviderOfferings()).rejects.toThrow("缺少必要欄位");
  });

  it("returns valid offerings", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        schema_version: 1,
        pricing_revision: "rev-1",
        currency: "akentros_point",
        billing_unit: "per_million_tokens",
        offerings: [{ id: "offering-1" }],
      }),
    );
    const offerings = await loadAkentrosProviderOfferings();
    expect(offerings.offerings).toHaveLength(1);
  });
});

describe("loadAkentrosBrandManifest", () => {
  it("validates asset identifiers", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { schema_version: 1, assets: [{ src: "no-id.png" }] }),
    );
    await expect(loadAkentrosBrandManifest()).rejects.toThrow("缺少必要欄位");
  });

  it("returns a valid manifest", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { schema_version: 1, assets: [{ id: "logo" }] }),
    );
    const manifest = await loadAkentrosBrandManifest();
    expect(manifest.assets).toHaveLength(1);
  });
});
