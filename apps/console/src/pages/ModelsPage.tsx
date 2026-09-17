import React from "react";
import { Alert, BrandMark, CopyButton, PageHeader, StateBlock } from "../components/ui";
import { loadBeaconBrandManifest, loadBeaconModels } from "../lib/beacon/catalog/loadBeaconCatalog";
import type { BeaconModel } from "../lib/beacon/types";
import { formatModelLimit, formatUsd } from "../lib/beacon/utils/formatBeacon";

// 模型目錄:資料來自 public/data/beacon(僅介面展示)。
// 計費卡片顯示每百萬 Token 的輸入/輸出美元價。

function InputModalityBadge({ modalities }: { modalities: string[] }) {
  const supported = modalities.includes("image");
  const description = supported
    ? "模型原生支援多模態輸入;Beacon API 目前仍提供文字介面。"
    : "此模型不支援多模態圖片輸入。";
  return (
    <span
      className={`tag${supported ? " badge-warn" : ""}`}
      title={description}
      role="img"
      aria-label={description}
      style={supported ? { color: "var(--accent-strong)", borderColor: "var(--accent-line)" } : undefined}
    >
      {supported ? "vision" : "text"}
    </span>
  );
}

export function ModelsPage() {
  const [catalog, setCatalog] = React.useState<Awaited<ReturnType<typeof loadBeaconModels>> | null>(null);
  const [brandAssets, setBrandAssets] = React.useState<
    Map<string, { display_asset_url: string | null; name: string; fallback_label: string }>
  >(new Map());
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    const controller = new AbortController();
    loadBeaconModels(controller.signal)
      .then(setCatalog)
      .catch((cause: Error) => {
        if (cause.name !== "AbortError") setError(cause.message);
      });
    loadBeaconBrandManifest(controller.signal)
      .then((manifest) => {
        setBrandAssets(new Map(manifest.assets.map((asset) => [asset.id, asset])));
      })
      .catch(() => {
        // 品牌 manifest 是裝飾性的;載入失敗時退回字母徽章即可。
      });
    return () => controller.abort();
  }, []);

  return (
    <>
      <PageHeader
        title="模型"
        subtitle={`${catalog?.models.length ?? "…"} 個模型・定價版本 ${catalog?.pricing_revision ?? "—"}`}
      />
      {error && (
        <div style={{ marginBottom: 12 }}>
          <Alert tone="error">{error}</Alert>
        </div>
      )}
      {!catalog && !error && (
        <div className="card">
          <StateBlock spinner>正在載入模型目錄…</StateBlock>
        </div>
      )}
      {catalog && (
        <div className="model-grid">
          {catalog.models.map((model: BeaconModel) => {
            const brand = brandAssets.get(model.owner_brand_asset_id);
            return (
              <article className="card model-card" key={model.id}>
                <div className="model-card-top">
                  <span>上下文 {formatModelLimit(model.context_window_tokens)}</span>
                  {model.status !== "available" && <span className="badge badge-warn">{model.status}</span>}
                </div>
                <div className="model-identity">
                  <BrandMark
                    assetUrl={brand?.display_asset_url}
                    fallback={model.owner}
                    alt={brand?.name || model.owner}
                  />
                  <div style={{ minWidth: 0 }}>
                    <h2>{model.display_name}</h2>
                    <div className="model-route">
                      <code title={`型號路由 ${model.id}`}>{model.id}</code>
                      <CopyButton value={model.id} label="複製型號路由" compact />
                    </div>
                  </div>
                </div>
                <p className="model-desc">{model.description}</p>
                <div className="model-tags">
                  {model.capabilities.map((capability) => (
                    <span className="tag" key={capability}>
                      {capability}
                    </span>
                  ))}
                  <InputModalityBadge modalities={model.input_modalities} />
                </div>
                <dl className="model-billing" style={{ margin: 0 }}>
                  <div>
                    <dt>輸入 / 1M Token</dt>
                    <dd>{formatUsd(model.billing.input_usd_per_million_tokens)}</dd>
                  </div>
                  <div>
                    <dt>輸出 / 1M Token</dt>
                    <dd>{formatUsd(model.billing.output_usd_per_million_tokens)}</dd>
                  </div>
                </dl>
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}
