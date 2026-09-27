import React from "react";
import { Link } from "react-router-dom";
import { Alert, PageHeader, StateBlock } from "../components/ui";
import { getAkentrosPublicApiRoot, getAkentrosUsageSummary } from "../lib/akentros/api/akentrosDeveloperApi";
import type { AkentrosUsageSummary } from "../lib/akentros/types";
import { formatTokens, formatUsd } from "../lib/akentros/utils/formatAkentros";

export function OverviewPage() {
  const [usage, setUsage] = React.useState<AkentrosUsageSummary | null>(null);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    const controller = new AbortController();
    getAkentrosUsageSummary(controller.signal)
      .then(setUsage)
      .catch((cause) => {
        if (cause.name !== "AbortError") setError(cause.message);
      });
    return () => controller.abort();
  }, []);

  return (
    <>
      <PageHeader
        title="總覽"
        subtitle="近 30 天的帳戶與用量摘要"
        action={
          <Link className="btn btn-primary" to="/keys">
            建立 API 金鑰
          </Link>
        }
      />
      {error && (
        <Alert tone="error">
          {error}
          <Link className="btn btn-sm" to="/">
            重新連線
          </Link>
        </Alert>
      )}
      <section className="metric-grid" aria-label="近 30 天使用摘要">
        {(
          [
            ["可用餘額", usage ? formatUsd(usage.balance_usd) : null],
            ["近 30 天請求", usage ? formatTokens(Number(usage.requests)) : null],
            ["近 30 天 Token", usage ? formatTokens(Number(usage.total_tokens)) : null],
            ["近 30 天消費", usage ? formatUsd(usage.charged_usd) : null],
          ] as const
        ).map(([label, value]) => (
          <article className="card metric" key={label}>
            <span>{label}</span>
            <strong>{value ?? "—"}</strong>
          </article>
        ))}
      </section>
      {!usage && !error && <StateBlock spinner>正在讀取用量摘要…</StateBlock>}
      <div className="two-col">
        <article className="card card-pad">
          <h2>API 端點</h2>
          <p style={{ margin: "0 0 12px", color: "var(--text-dim)", fontSize: "0.8rem" }}>
            與 OpenAI Chat Completions 相容,任何 OpenAI SDK 指向以下 Base URL 即可使用。
          </p>
          <label className="field">
            <span>Base URL</span>
            <input
              className="input input-mono"
              readOnly
              value={getAkentrosPublicApiRoot()}
              onFocus={(event) => event.currentTarget.select()}
            />
          </label>
          <div style={{ marginTop: "10px" }}>
            <div className="endpoint-row">
              <span className="endpoint-method">POST</span>
              <code>/chat/completions</code>
            </div>
            <div className="endpoint-row">
              <span className="endpoint-method get">GET</span>
              <code>/models</code>
            </div>
          </div>
          <small style={{ color: "var(--text-faint)", fontSize: "0.72rem" }}>
            Authorization: Bearer sk-akentros-live_…
          </small>
        </article>
        <article className="card card-pad">
          <h2>常用操作</h2>
          <div style={{ marginTop: 8 }}>
            <Link className="link-row" to="/playground">
              <span>串流測試</span>
              <small>即時查看回應</small>
            </Link>
            <Link className="link-row" to="/docs">
              <span>快速開始</span>
              <small>查看呼叫範例</small>
            </Link>
            <Link className="link-row" to="/models">
              <span>模型</span>
              <small>查看模型與計費</small>
            </Link>
            <Link className="link-row" to="/logs">
              <span>請求紀錄</span>
              <small>查看用量與狀態</small>
            </Link>
          </div>
        </article>
      </div>
    </>
  );
}
