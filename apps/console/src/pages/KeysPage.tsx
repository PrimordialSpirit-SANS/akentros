import React from "react";
import { Alert, Dialog, PageHeader, StateBlock } from "../components/ui";
import {
  createAkentrosKey,
  listAkentrosKeys,
  revokeAkentrosKey,
  rotateAkentrosKey,
} from "../lib/akentros/api/akentrosDeveloperApi";
import type { AkentrosApiKey } from "../lib/akentros/types";
import { formatAkentrosTimestamp, formatUsd } from "../lib/akentros/utils/formatAkentros";

const MIN_KEY_TTL_MS = 60 * 60 * 1000;

function toDateTimeLocalValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

function defaultKeyExpiryValue(): string {
  return toDateTimeLocalValue(new Date(Date.now() + 30 * 24 * 60 * 60_000));
}

function formatKeyExpiry(value: string | null): string {
  return value ? formatAkentrosTimestamp(value) : "永不過期";
}

export function KeysPage() {
  const [keys, setKeys] = React.useState<AkentrosApiKey[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [name, setName] = React.useState("Production");
  const [expiryMode, setExpiryMode] = React.useState<"never" | "custom">("never");
  const [expiryValue, setExpiryValue] = React.useState(defaultKeyExpiryValue);
  const [pointLimitMode, setPointLimitMode] = React.useState<"unlimited" | "limited">("unlimited");
  const [pointLimitValue, setPointLimitValue] = React.useState("50.00");
  const [secret, setSecret] = React.useState("");
  const [busy, setBusy] = React.useState("");
  const [pendingRevoke, setPendingRevoke] = React.useState<AkentrosApiKey | null>(null);

  const reload = React.useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setKeys(await listAkentrosKeys());
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;

    let expiresAt: string | null = null;
    if (expiryMode === "custom") {
      const parsedExpiry = new Date(expiryValue);
      if (Number.isNaN(parsedExpiry.getTime()) || parsedExpiry.getTime() < Date.now() + MIN_KEY_TTL_MS) {
        setError("過期時間必須至少距現在 1 小時。");
        return;
      }
      expiresAt = parsedExpiry.toISOString();
    }

    let spendLimitUsd: string | null = null;
    if (pointLimitMode === "limited") {
      const amount = Number(pointLimitValue);
      if (!Number.isFinite(amount) || amount < 0 || pointLimitValue.trim() === "") {
        setError("消費上限必須是 0 以上的金額(美元)。");
        return;
      }
      spendLimitUsd = amount.toFixed(2);
    }

    setBusy("create");
    setError("");
    try {
      const result = await createAkentrosKey({
        name: name.trim(),
        expires_at: expiresAt,
        spend_limit_usd: spendLimitUsd,
      });
      setSecret(result.api_key);
      await reload();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy("");
    }
  };

  const rotate = async (key: AkentrosApiKey) => {
    setBusy(key.id);
    setError("");
    try {
      const result = await rotateAkentrosKey(key.id);
      setSecret(result.api_key);
      await reload();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy("");
    }
  };

  const revoke = async () => {
    if (!pendingRevoke) return;
    setBusy(pendingRevoke.id);
    try {
      await revokeAkentrosKey(pendingRevoke.id);
      setPendingRevoke(null);
      await reload();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy("");
    }
  };

  return (
    <>
      <PageHeader title="API 金鑰" subtitle="金鑰只會在建立或輪替時顯示一次,請立即安全保存。" />
      <form className="card card-pad" onSubmit={create} style={{ marginBottom: 12 }}>
        <h2>建立新金鑰</h2>
        <p style={{ margin: "0 0 16px", color: "var(--text-dim)", fontSize: "0.8rem" }}>
          為不同環境設定獨立的有效期限與消費預算(美元)。
        </p>
        <div
          style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}
        >
          <label className="field">
            <span>金鑰名稱</span>
            <input
              className="input"
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
              placeholder="Production"
            />
            <small>使用容易辨識的服務或環境名稱。</small>
          </label>
          <div className="field">
            <span>過期時間</span>
            <fieldset className="choice" aria-label="金鑰過期方式">
              <button
                type="button"
                className={expiryMode === "never" ? "active" : ""}
                onClick={() => setExpiryMode("never")}
              >
                永不過期
              </button>
              <button
                type="button"
                className={expiryMode === "custom" ? "active" : ""}
                onClick={() => setExpiryMode("custom")}
              >
                自訂期限
              </button>
            </fieldset>
            {expiryMode === "custom" ? (
              <>
                <input
                  className="input"
                  aria-label="金鑰過期時間"
                  type="datetime-local"
                  min={toDateTimeLocalValue(new Date(Date.now() + MIN_KEY_TTL_MS + 60_000))}
                  value={expiryValue}
                  onChange={(event) => setExpiryValue(event.target.value)}
                  required
                />
                <small>最早可設定為目前時間的 1 小時後。</small>
              </>
            ) : (
              <small>金鑰會持續有效,直到手動撤銷。</small>
            )}
          </div>
          <div className="field">
            <span>消費上限(USD)</span>
            <fieldset className="choice" aria-label="消費上限">
              <button
                type="button"
                className={pointLimitMode === "unlimited" ? "active" : ""}
                onClick={() => setPointLimitMode("unlimited")}
              >
                無限制
              </button>
              <button
                type="button"
                className={pointLimitMode === "limited" ? "active" : ""}
                onClick={() => setPointLimitMode("limited")}
              >
                設定上限
              </button>
            </fieldset>
            {pointLimitMode === "limited" ? (
              <>
                <input
                  className="input"
                  aria-label="消費上限"
                  type="number"
                  min={0}
                  step="0.01"
                  placeholder="50.00"
                  value={pointLimitValue}
                  onChange={(event) => setPointLimitValue(event.target.value)}
                  required
                />
                <small>此金鑰累積消費達上限後,新請求會被拒絕。</small>
              </>
            ) : (
              <small>不限制此金鑰可累積消費的金額。</small>
            )}
          </div>
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 10,
            marginTop: 16,
            flexWrap: "wrap",
          }}
        >
          <small style={{ color: "var(--text-faint)", fontSize: "0.74rem" }}>
            金鑰只會顯示一次,建立後請立即安全保存。
          </small>
          <button className="btn btn-primary" type="submit" disabled={busy === "create"}>
            {busy === "create" ? "建立中…" : "建立金鑰"}
          </button>
        </div>
      </form>

      {error && (
        <div style={{ marginBottom: 12 }}>
          <Alert
            tone="error"
            action={
              <button className="btn btn-sm" type="button" onClick={() => void reload()} disabled={loading}>
                重新連線
              </button>
            }
          >
            {error}
          </Alert>
        </div>
      )}

      <section className="card" aria-label="金鑰清單">
        {loading ? (
          <StateBlock spinner>正在讀取金鑰…</StateBlock>
        ) : !error && keys.length === 0 ? (
          <StateBlock>尚未建立金鑰。建立第一把金鑰後即可呼叫 API。</StateBlock>
        ) : (
          keys.map((key) => {
            const quotaPercent =
              key.spend_limit_usd != null && Number(key.spend_limit_usd) > 0
                ? Math.min(
                    100,
                    Math.round((Number(key.spend_used_usd || 0) / Number(key.spend_limit_usd)) * 100),
                  )
                : null;
            return (
              <article className="key-row" key={key.id}>
                <div className="key-identity">
                  <strong>{key.name}</strong>
                  <code>
                    {key.key_prefix}••••••••{key.key_suffix}
                  </code>
                  {quotaPercent !== null && (
                    <div className="quota-bar" title={`${quotaPercent}%`}>
                      <i style={{ width: `${quotaPercent}%` }} />
                    </div>
                  )}
                </div>
                <div className="key-meta">
                  <span>建立 {formatAkentrosTimestamp(key.created_at)}</span>
                  <span>最後使用 {formatAkentrosTimestamp(key.last_used_at)}</span>
                  <span>到期 {formatKeyExpiry(key.expires_at)}</span>
                  <span>
                    消費 {formatUsd(key.spend_used_usd)} /{" "}
                    {key.spend_limit_usd == null ? "無限制" : formatUsd(key.spend_limit_usd)}
                  </span>
                </div>
                <div className="key-actions">
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => void rotate(key)}
                    disabled={busy === key.id}
                  >
                    輪替
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    onClick={() => setPendingRevoke(key)}
                    disabled={busy === key.id}
                  >
                    撤銷
                  </button>
                </div>
              </article>
            );
          })
        )}
      </section>

      {secret && (
        <Dialog
          title="現在複製這把金鑰"
          actions={
            <>
              <button
                type="button"
                className="btn btn-primary"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(secret);
                  } catch {
                    /* 剪貼簿不可用時仍可手動選取 */
                  }
                }}
              >
                複製金鑰
              </button>
              <button type="button" className="btn" onClick={() => setSecret("")}>
                我已安全保存
              </button>
            </>
          }
        >
          <p>關閉後就無法再次查看。請存入密碼管理器或伺服器環境變數。</p>
          <code className="secret-box">{secret}</code>
        </Dialog>
      )}

      {pendingRevoke && (
        <Dialog
          title={`撤銷「${pendingRevoke.name}」?`}
          actions={
            <>
              <button type="button" className="btn btn-danger" onClick={() => void revoke()}>
                確認撤銷
              </button>
              <button type="button" className="btn" onClick={() => setPendingRevoke(null)}>
                取消
              </button>
            </>
          }
        >
          <p>使用這把金鑰的請求會立即失敗。此動作無法復原。</p>
        </Dialog>
      )}
    </>
  );
}
