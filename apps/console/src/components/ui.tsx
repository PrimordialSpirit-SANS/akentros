import React from "react";

// 控制台共用的小型 UI 元件。樣式全部對應 index.css 的設計系統類別。

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {action && <div>{action}</div>}
    </header>
  );
}

export function StateBlock({ children, spinner }: { children: React.ReactNode; spinner?: boolean }) {
  return (
    <div className="state-block">
      {spinner && <span className="spinner" aria-hidden="true" />}
      <span>{children}</span>
    </div>
  );
}

export function Alert({
  tone = "info",
  children,
  action,
}: {
  tone?: "info" | "error";
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div
      className={`alert${tone === "error" ? " alert-error" : ""}`}
      role={tone === "error" ? "alert" : undefined}
    >
      <span>{children}</span>
      {action}
    </div>
  );
}

export function Dialog({
  title,
  children,
  actions,
}: {
  title: string;
  children: React.ReactNode;
  actions: React.ReactNode;
}) {
  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
        <div className="dialog-actions">{actions}</div>
      </section>
    </div>
  );
}

export function CopyButton({
  value,
  label = "複製",
  compact,
}: {
  value: string;
  label?: string;
  compact?: boolean;
}) {
  const [copied, setCopied] = React.useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };
  if (compact) {
    return (
      <button
        type="button"
        className={`icon-btn${copied ? " copied" : ""}`}
        onClick={() => void copy()}
        aria-label={copied ? "已複製" : label}
        title={copied ? "已複製" : label}
      >
        {copied ? (
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m5 12 4 4L19 6" />
          </svg>
        ) : (
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="8" y="8" width="11" height="11" rx="2" />
            <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
          </svg>
        )}
      </button>
    );
  }
  return (
    <button type="button" className="btn btn-sm" onClick={() => void copy()}>
      {copied ? "已複製" : label}
    </button>
  );
}

// 模型/供應商品牌標記:manifest 沒有提供圖示時,退回品牌字首徽章。
export function BrandMark({
  assetUrl,
  fallback,
  alt,
}: {
  assetUrl?: string | null;
  fallback: string;
  alt: string;
}) {
  const [failed, setFailed] = React.useState(false);
  const letter = (alt || fallback || "?").slice(0, 1).toUpperCase();
  return (
    <span className="brand-mark" aria-label={alt || fallback}>
      {assetUrl && !failed ? (
        <img src={assetUrl} alt="" loading="lazy" onError={() => setFailed(true)} />
      ) : (
        <span aria-hidden="true">{letter}</span>
      )}
    </span>
  );
}

export function formatDuration(value: number | null): string {
  if (value === null) return "—";
  if (value < 1000) return `${Math.round(value).toLocaleString("zh-TW")} ms`;
  return `${(value / 1000).toFixed(2)} s`;
}
