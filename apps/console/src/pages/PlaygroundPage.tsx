import React from "react";
import { Alert, formatDuration, PageHeader } from "../components/ui";
import { type BeaconStreamDeltaEvent, streamBeaconChat } from "../lib/beacon/api/beaconChatStream";
import { loadBeaconModels } from "../lib/beacon/catalog/loadBeaconCatalog";
import type { BeaconChatUsage, BeaconModel } from "../lib/beacon/types";

// 串流測試(Playground):雙欄佈局,左側請求參數、右側即時輸出。
// 輸出以 rAF 節流更新,避免每個 delta 都觸發 re-render。

type RunStatus = "idle" | "connecting" | "streaming" | "complete" | "stopped" | "error";

const STATUS_BADGES: Record<RunStatus, { label: string; className: string }> = {
  idle: { label: "待命", className: "badge" },
  connecting: { label: "連線中", className: "badge badge-warn" },
  streaming: { label: "生成中", className: "badge badge-info" },
  complete: { label: "完成", className: "badge badge-ok" },
  stopped: { label: "已停止", className: "badge" },
  error: { label: "錯誤", className: "badge badge-err" },
};

const PRESETS = [
  { label: "自我介紹", prompt: "你好!請簡單自我介紹,並說明你能提供哪些協助。" },
  { label: "寫詩", prompt: "請以繁體中文寫一首描寫秋天夜空的五言律詩。" },
  { label: "程式碼", prompt: "請用 Python 寫一個快速判斷質數的函式,並加上範例與註解。" },
];

function countCharacters(value: string): number {
  return Array.from(value).length;
}

function isAbortError(cause: unknown): boolean {
  return (
    (cause instanceof DOMException && cause.name === "AbortError") ||
    (typeof cause === "object" &&
      cause !== null &&
      "name" in cause &&
      (cause as { name: string }).name === "AbortError")
  );
}

export function PlaygroundPage() {
  const [models, setModels] = React.useState<BeaconModel[]>([]);
  const [catalogError, setCatalogError] = React.useState("");
  const [authMode, setAuthMode] = React.useState<"account" | "api-key">("account");
  const [apiKey, setApiKey] = React.useState("");
  const [modelId, setModelId] = React.useState("");
  const [modelMenuOpen, setModelMenuOpen] = React.useState(false);
  const [activeModelIndex, setActiveModelIndex] = React.useState(0);
  const [prompt, setPrompt] = React.useState(PRESETS[0].prompt);
  const [maxTokens, setMaxTokens] = React.useState(1024);
  const [status, setStatus] = React.useState<RunStatus>("idle");
  const [output, setOutput] = React.useState("");
  const [reasoningCharacters, setReasoningCharacters] = React.useState(0);
  const [usage, setUsage] = React.useState<BeaconChatUsage | null>(null);
  const [firstDeltaMs, setFirstDeltaMs] = React.useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = React.useState(0);
  const [error, setError] = React.useState("");

  const abortRef = React.useRef<AbortController | null>(null);
  const frameRef = React.useRef<number | null>(null);
  const startedAtRef = React.useRef(0);
  const firstDeltaRef = React.useRef<number | null>(null);
  const contentRef = React.useRef("");
  const reasoningRef = React.useRef("");
  const modelPickerRef = React.useRef<HTMLDivElement | null>(null);

  const running = status === "connecting" || status === "streaming";
  const normalizedModelId = modelId.trim();
  const selectedModel = models.find((model) => model.id === normalizedModelId);
  const maxOutputTokens = selectedModel?.max_output_tokens || 8192;
  const filteredModels = React.useMemo(() => {
    const query = normalizedModelId.toLocaleLowerCase();
    if (!query) return models;
    return models.filter((model) =>
      `${model.id} ${model.display_name} ${model.owner}`.toLocaleLowerCase().includes(query),
    );
  }, [models, normalizedModelId]);

  React.useEffect(() => {
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!modelPickerRef.current?.contains(event.target as Node)) setModelMenuOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, []);

  React.useEffect(() => {
    const controller = new AbortController();
    loadBeaconModels(controller.signal)
      .then((catalog) => {
        const streamable = catalog.models.filter(
          (model) => model.status === "available" && model.capabilities.includes("streaming"),
        );
        setModels(streamable);
        if (streamable.length > 0) {
          setModelId((current) => {
            if (current && streamable.some((model) => model.id === current)) return current;
            const defaultModel = streamable[0];
            setMaxTokens(Math.min(1024, defaultModel.max_output_tokens));
            return defaultModel.id;
          });
        }
      })
      .catch((cause: Error) => {
        if (cause.name !== "AbortError") setCatalogError(cause.message);
      });
    return () => controller.abort();
  }, []);

  React.useEffect(() => {
    if (!running) return undefined;
    const timer = window.setInterval(() => {
      setElapsedMs(performance.now() - startedAtRef.current);
    }, 100);
    return () => window.clearInterval(timer);
  }, [running]);

  React.useEffect(
    () => () => {
      abortRef.current?.abort();
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  const resetResult = React.useCallback(() => {
    contentRef.current = "";
    reasoningRef.current = "";
    firstDeltaRef.current = null;
    setOutput("");
    setReasoningCharacters(0);
    setUsage(null);
    setFirstDeltaMs(null);
    setElapsedMs(0);
    setError("");
  }, []);

  const scheduleOutput = React.useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      setOutput(contentRef.current);
      setReasoningCharacters(countCharacters(reasoningRef.current));
    });
  }, []);

  const flushOutput = React.useCallback(() => {
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    setOutput(contentRef.current);
    setReasoningCharacters(countCharacters(reasoningRef.current));
  }, []);

  const onDelta = React.useCallback(
    (event: BeaconStreamDeltaEvent) => {
      contentRef.current += event.content;
      reasoningRef.current += event.reasoning;
      if (firstDeltaRef.current === null) {
        firstDeltaRef.current = event.elapsedMs;
        setFirstDeltaMs(event.elapsedMs);
      }
      setStatus("streaming");
      scheduleOutput();
    },
    [scheduleOutput],
  );

  const changeModel = (nextModelId: string) => {
    setModelId(nextModelId);
    const nextModel = models.find((model) => model.id === nextModelId);
    if (nextModel) setMaxTokens((current) => Math.min(current, nextModel.max_output_tokens));
  };

  const chooseModel = (model: BeaconModel) => {
    changeModel(model.id);
    setModelMenuOpen(false);
    setActiveModelIndex(0);
  };

  const start = async (event: React.FormEvent) => {
    event.preventDefault();
    if (running) return;

    if (authMode === "api-key" && !apiKey.trim()) {
      setError("請輸入 API 金鑰。");
      return;
    }
    if (!normalizedModelId) {
      setError("請選擇或輸入欲測試的模型。");
      return;
    }
    if (!prompt.trim()) {
      setError("請輸入訊息。");
      return;
    }

    resetResult();
    setStatus("connecting");
    startedAtRef.current = performance.now();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const result = await streamBeaconChat({
        authMode,
        apiKey: authMode === "api-key" ? apiKey.trim() : undefined,
        model: normalizedModelId,
        messages: [{ role: "user", content: prompt.trim() }],
        maxCompletionTokens: Math.min(maxTokens, maxOutputTokens),
        signal: controller.signal,
        onDelta,
        onUsage: setUsage,
      });
      flushOutput();
      setUsage(result.usage);
      setFirstDeltaMs(result.metrics.firstDeltaLatencyMs);
      setElapsedMs(result.metrics.totalLatencyMs);
      setStatus("complete");
    } catch (cause) {
      flushOutput();
      setElapsedMs(performance.now() - startedAtRef.current);
      if (isAbortError(cause)) {
        setStatus("stopped");
      } else {
        setStatus("error");
        setError(cause instanceof Error ? cause.message : "Beacon 串流測試失敗。");
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  const stop = () => abortRef.current?.abort();
  const clearResult = () => {
    if (running) return;
    resetResult();
    setStatus("idle");
  };

  const statusBadge = STATUS_BADGES[status];
  const placeholder = running
    ? reasoningCharacters > 0
      ? "推理中…"
      : "等待首段回應…"
    : status === "stopped"
      ? "生成已停止。"
      : "尚未開始";

  return (
    <>
      <PageHeader
        title="串流測試"
        subtitle="以 OpenAI 相容端點即時驗證模型回應"
        action={
          <span className={statusBadge.className} role="status" aria-live="polite">
            {statusBadge.label}
          </span>
        }
      />
      {catalogError && (
        <div style={{ marginBottom: 12 }}>
          <Alert tone="error">{catalogError}</Alert>
        </div>
      )}
      <div className="playground">
        <form className="card card-pad form-grid" onSubmit={start}>
          <div className="field">
            <span>認證方式</span>
            <div className="choice" role="group" aria-label="認證方式">
              <button
                type="button"
                className={authMode === "account" ? "active" : ""}
                onClick={() => setAuthMode("account")}
                disabled={running}
              >
                登入工作階段
              </button>
              <button
                type="button"
                className={authMode === "api-key" ? "active" : ""}
                onClick={() => setAuthMode("api-key")}
                disabled={running}
              >
                API 金鑰
              </button>
            </div>
            <small>
              {authMode === "account"
                ? "免填金鑰,直接使用帳戶餘額測試。"
                : "輸入專屬 sk-beacon-live_… 金鑰進行公開端點驗證。"}
            </small>
          </div>

          {authMode === "api-key" && (
            <label className="field">
              <span>API 金鑰</span>
              <input
                className="input input-mono"
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                placeholder="sk-beacon-live_…"
                disabled={running}
              />
            </label>
          )}

          <div className="form-row">
            <div className="field model-picker" ref={modelPickerRef}>
              <span>模型</span>
              <input
                className="input input-mono"
                type="search"
                value={modelId}
                onChange={(event) => {
                  changeModel(event.target.value);
                  setModelMenuOpen(true);
                  setActiveModelIndex(0);
                }}
                onFocus={() => setModelMenuOpen(true)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setModelMenuOpen(false);
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    setModelMenuOpen(true);
                    const direction = event.key === "ArrowDown" ? 1 : -1;
                    setActiveModelIndex((current) =>
                      Math.max(0, Math.min(filteredModels.length - 1, current + direction)),
                    );
                  }
                  if (event.key === "Enter" && modelMenuOpen && filteredModels[activeModelIndex]) {
                    event.preventDefault();
                    chooseModel(filteredModels[activeModelIndex]);
                  }
                }}
                placeholder="請輸入模型型號"
                autoComplete="off"
                spellCheck={false}
                role="combobox"
                aria-expanded={modelMenuOpen}
                aria-controls="beacon-model-options"
                disabled={running}
              />
              {modelMenuOpen && (
                <div className="model-picker-menu" id="beacon-model-options" role="listbox">
                  {filteredModels.length ? (
                    filteredModels.map((model, index) => (
                      <button
                        type="button"
                        key={model.id}
                        role="option"
                        aria-selected={model.id === normalizedModelId}
                        className={`model-option${index === activeModelIndex ? " active" : ""}`}
                        onMouseEnter={() => setActiveModelIndex(index)}
                        onClick={() => chooseModel(model)}
                      >
                        <strong>{model.id}</strong>
                        <span>{model.display_name}</span>
                      </button>
                    ))
                  ) : (
                    <div className="model-empty">沒有相符型號,可直接使用目前輸入值</div>
                  )}
                </div>
              )}
            </div>
            <label className="field">
              <span>最大輸出 Token</span>
              <input
                className="input"
                type="number"
                min={1}
                max={maxOutputTokens}
                value={maxTokens}
                onChange={(event) =>
                  setMaxTokens(Math.min(maxOutputTokens, Math.max(1, Number(event.target.value) || 1)))
                }
                disabled={running}
              />
            </label>
          </div>

          <div className="field">
            <span>訊息</span>
            <div className="prompt-presets">
              {PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  className="chip"
                  onClick={() => setPrompt(preset.prompt)}
                  disabled={running}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <textarea
              className="textarea"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="請輸入訊息"
              rows={7}
              disabled={running}
            />
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-primary" type="submit" disabled={running} style={{ flex: 1 }}>
              {running ? "生成中…" : "開始生成"}
            </button>
            <button className="btn btn-danger" type="button" onClick={stop} disabled={!running}>
              停止
            </button>
          </div>
        </form>

        <article className="card" style={{ overflow: "hidden" }}>
          <header className="pane-header">
            <h2>回應</h2>
            <div className="pane-actions">
              <button
                type="button"
                className="btn btn-sm"
                onClick={async () => {
                  if (!output) return;
                  try {
                    await navigator.clipboard.writeText(output);
                  } catch {
                    /* 忽略 */
                  }
                }}
                disabled={!output}
              >
                複製
              </button>
              <button type="button" className="btn btn-sm" onClick={clearResult} disabled={running}>
                清除
              </button>
            </div>
          </header>

          <dl className="metrics-strip" style={{ margin: 0 }}>
            <div className="metric-cell">
              <span>字元</span>
              <strong>{countCharacters(output).toLocaleString("zh-TW")}</strong>
            </div>
            <div className="metric-cell">
              <span>輸出 Token</span>
              <strong>{usage ? usage.completion_tokens.toLocaleString("zh-TW") : "—"}</strong>
            </div>
            <div className="metric-cell">
              <span>首段</span>
              <strong>{formatDuration(firstDeltaMs)}</strong>
            </div>
            <div className="metric-cell">
              <span>耗時</span>
              <strong>{formatDuration(elapsedMs)}</strong>
            </div>
          </dl>

          {reasoningCharacters > 0 && (
            <div className="reasoning-note">
              推理文字 {reasoningCharacters.toLocaleString("zh-TW")} 字元
              {usage?.completion_tokens_details
                ? ` · 推理 ${usage.completion_tokens_details.reasoning_tokens.toLocaleString("zh-TW")} Token(已含於輸出)`
                : "(字元數不等於 Token 數)"}
            </div>
          )}

          <pre className={`output-pane${output ? "" : " empty"}`} aria-live="polite" aria-busy={running}>
            {output || placeholder}
          </pre>

          {error && (
            <div className="output-error" role="alert">
              {error}
            </div>
          )}
        </article>
      </div>
    </>
  );
}
