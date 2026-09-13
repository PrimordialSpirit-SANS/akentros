import React from "react";
import { CopyButton, PageHeader } from "../components/ui";
import { getBeaconChatCompletionsUrl, getBeaconPublicApiRoot } from "../lib/beacon/api/beaconDeveloperApi";
import { buildCodeExamples, type CodeLanguage } from "../lib/beacon/utils/buildCodeExamples";

export function DocsPage() {
  const [language, setLanguage] = React.useState<CodeLanguage>("curl");
  const examples = buildCodeExamples(getBeaconPublicApiRoot(), "YOUR_MODEL_ID");
  const current = examples[language];

  return (
    <>
      <PageHeader
        title="快速開始"
        subtitle="四步驟送出第一個請求;回應格式與 OpenAI Chat Completions 相容。"
      />
      <ol className="steps">
        <li className="card">
          <span>01</span>
          <strong>建立金鑰</strong>
          <p>在「API 金鑰」頁建立並安全保存 secret。</p>
        </li>
        <li className="card">
          <span>02</span>
          <strong>設定環境變數</strong>
          <code>BEACON_API_KEY=sk-beacon-live_…</code>
        </li>
        <li className="card">
          <span>03</span>
          <strong>選擇模型</strong>
          <code>YOUR_MODEL_ID</code>
        </li>
        <li className="card">
          <span>04</span>
          <strong>送出請求</strong>
          <p>以下任一語言的範例都能直接執行。</p>
        </li>
      </ol>

      <div>
        <div className="code-tabs" role="tablist" aria-label="程式語言">
          {(Object.keys(examples) as CodeLanguage[]).map((item) => (
            <button
              key={item}
              role="tab"
              aria-selected={language === item}
              className={language === item ? "active" : ""}
              onClick={() => setLanguage(item)}
            >
              {examples[item].label}
            </button>
          ))}
          <span className="copy-slot">
            <CopyButton value={current.code} label="COPY" />
          </span>
        </div>
        <pre className="code-block">
          <code>{current.code}</code>
        </pre>
      </div>

      <div className="card callout">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M4 5.5A3.5 3.5 0 0 1 7.5 2H20v17H7.5A3.5 3.5 0 0 0 4 22.5Z" />
          <path d="M4 5.5v17M8 7h8M8 11h6" />
        </svg>
        <div>
          <strong style={{ fontSize: "0.84rem" }}>Endpoint</strong>
          <div>
            <code>{getBeaconChatCompletionsUrl()}</code>
          </div>
        </div>
      </div>
    </>
  );
}
