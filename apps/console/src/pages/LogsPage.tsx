import React from "react";
import { Alert, PageHeader, StateBlock } from "../components/ui";
import { getBeaconRequestDetail, listBeaconLogs } from "../lib/beacon/api/beaconDeveloperApi";
import type { BeaconRequestDetail, BeaconUsageLog } from "../lib/beacon/types";
import {
  formatBeaconTimestamp,
  formatLatency,
  formatTokens,
  formatUsd,
} from "../lib/beacon/utils/formatBeacon";

const STATUS_LABELS: Record<string, { label: string; className: string }> = {
  succeeded: { label: "成功", className: "badge badge-ok" },
  partially_succeeded: { label: "部分成功", className: "badge badge-warn" },
  rejected: { label: "拒絕", className: "badge badge-err" },
  refunded: { label: "已退款", className: "badge badge-info" },
  dispatched: { label: "處理中", className: "badge" },
  needs_reconciliation: { label: "待核對", className: "badge badge-warn" },
};

function statusBadge(status: string) {
  const known = STATUS_LABELS[status] || { label: status, className: "badge" };
  return <span className={known.className}>{known.label}</span>;
}

export function LogsPage() {
  const [logs, setLogs] = React.useState<BeaconUsageLog[]>([]);
  const [pagination, setPagination] = React.useState({ next_cursor: null as string | null, has_more: false });
  const [status, setStatus] = React.useState("");
  const [error, setError] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [detail, setDetail] = React.useState<BeaconRequestDetail | null>(null);

  const load = React.useCallback(
    async (cursor: string | null = null, append = false) => {
      setLoading(true);
      setError("");
      try {
        const page = await listBeaconLogs({ cursor, limit: 25, status: status || undefined });
        setLogs((current) => (append ? [...current, ...page.logs] : page.logs));
        setPagination(page.pagination);
      } catch (cause) {
        setError((cause as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [status],
  );

  React.useEffect(() => {
    void load();
  }, [load]);

  React.useEffect(() => {
    if (!detail) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDetail(null);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [detail]);

  const open = async (requestId: string) => {
    try {
      setDetail(await getBeaconRequestDetail(requestId));
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  const detailRows: Array<[string, string]> = detail
    ? [
        ["狀態", STATUS_LABELS[detail.status]?.label || detail.status],
        ["公開模型", detail.requested_model],
        ["實際模型", detail.actual_model || "—"],
        ["供應商", detail.provider || "—"],
        ["Input tokens", formatTokens(Number(detail.input_tokens))],
        ["Output tokens", formatTokens(Number(detail.output_tokens))],
        ["扣除金額", formatUsd(detail.charged_usd)],
        ["總延遲", formatLatency(detail.latency_ms)],
        ["錯誤代碼", detail.error_code || "—"],
      ]
    : [];

  return (
    <>
      <PageHeader
        title="請求紀錄"
        subtitle="點擊任一列查看單筆請求詳情"
        action={
          <select
            className="select"
            style={{ width: "auto" }}
            aria-label="依狀態篩選"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="">全部狀態</option>
            <option value="succeeded">成功</option>
            <option value="refunded">已退款</option>
            <option value="rejected">拒絕</option>
            <option value="needs_reconciliation">待核對</option>
          </select>
        }
      />
      {error && (
        <div style={{ marginBottom: 12 }}>
          <Alert
            tone="error"
            action={
              <button className="btn btn-sm" type="button" onClick={() => void load()} disabled={loading}>
                重新連線
              </button>
            }
          >
            {error}
          </Alert>
        </div>
      )}
      <div className="card table-wrap">
        {logs.length > 0 ? (
          <table className="table">
            <thead>
              <tr>
                <th>時間</th>
                <th>模型</th>
                <th>狀態</th>
                <th>Token</th>
                <th>消費</th>
                <th>延遲</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr
                  key={log.request_id}
                  tabIndex={0}
                  onClick={() => void open(log.request_id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void open(log.request_id);
                  }}
                >
                  <td className="cell-time">
                    {formatBeaconTimestamp(log.created_at)}
                    <code>{log.request_id}</code>
                  </td>
                  <td className="cell-model">
                    <code>{log.requested_model}</code>
                    <small>{log.key_name || "API 金鑰"}</small>
                  </td>
                  <td>{statusBadge(log.status)}</td>
                  <td>{formatTokens(Number(log.total_tokens))}</td>
                  <td>{formatUsd(log.charged_usd)}</td>
                  <td>{formatLatency(log.latency_ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : loading ? (
          <StateBlock spinner>正在讀取請求紀錄…</StateBlock>
        ) : !error ? (
          <StateBlock>尚無請求紀錄。</StateBlock>
        ) : null}
      </div>
      {pagination.has_more && (
        <div className="load-more">
          <button
            className="btn"
            type="button"
            onClick={() => void load(pagination.next_cursor, true)}
            disabled={loading}
          >
            載入更多
          </button>
        </div>
      )}

      {detail && (
        <>
          <button
            type="button"
            className="drawer-backdrop"
            onClick={() => setDetail(null)}
            aria-label="關閉請求詳細資料"
            tabIndex={-1}
          />
          <aside className="drawer" role="dialog" aria-modal="true" aria-label="請求詳細資料">
            <button
              type="button"
              className="btn btn-sm drawer-close"
              onClick={() => setDetail(null)}
              aria-label="關閉"
            >
              ×
            </button>
            <h2>請求詳細資料</h2>
            <code className="drawer-request-id">{detail.request_id}</code>
            <dl className="detail-list" style={{ margin: 0 }}>
              {detailRows.map(([term, value]) => (
                <div className="detail-row" key={term}>
                  <dt>{term}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </aside>
        </>
      )}
    </>
  );
}
