import React from "react";
import { useNavigate } from "react-router-dom";
import { AkentrosIcon } from "../components/AkentrosIcon";
import {
  AkentrosAuthError,
  loginAkentrosAccount,
  registerAkentrosAccount,
} from "../lib/akentros/api/akentrosAuthApi";
import type { AkentrosConsoleUser } from "../lib/akentros/types";
import { isAkentrosDemoMode } from "../services/demoApi";

// 登入/註冊二合一頁。成功後寫入 session context 並導向控制台。
// 示範模式會顯示提示:任意帳號密碼即可登入。

type AuthMode = "login" | "register";

export function LoginPage({ onAuthenticated }: { onAuthenticated: (user: AkentrosConsoleUser) => void }) {
  const navigate = useNavigate();
  const demo = isAkentrosDemoMode();
  const [mode, setMode] = React.useState<AuthMode>("login");
  const [email, setEmail] = React.useState("");
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError("");
    setBusy(true);
    try {
      const user =
        mode === "login"
          ? await loginAkentrosAccount(email, password)
          : await registerAkentrosAccount(email, username, password);
      onAuthenticated(user);
      navigate("/", { replace: true });
    } catch (cause) {
      setError(cause instanceof AkentrosAuthError ? cause.message : "操作失敗,請稍後再試。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <section className="card auth-card">
        <div className="auth-brand">
          <AkentrosIcon size={40} />
          <h1>Akentros 控制台</h1>
          <p>{mode === "login" ? "登入以管理 API 金鑰與用量" : "建立新帳號,開始使用 Akentros"}</p>
        </div>
        <form className="auth-form" onSubmit={submit}>
          <label className="field">
            <span>電子郵件</span>
            <input
              className="input"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              placeholder={demo ? "demo@akentros.dev" : "you@example.com"}
              required
            />
          </label>
          {mode === "register" && (
            <label className="field">
              <span>使用者名稱</span>
              <input
                className="input"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                minLength={2}
                maxLength={40}
                autoComplete="username"
                placeholder="how you'll be shown"
                required
              />
            </label>
          )}
          <label className="field">
            <span>密碼</span>
            <input
              className="input"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              placeholder={mode === "login" ? "" : "至少 8 字元"}
              minLength={mode === "register" ? 8 : undefined}
              required
            />
          </label>
          {error && (
            <div className="alert alert-error">
              <span>{error}</span>
            </div>
          )}
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? "處理中…" : mode === "login" ? "登入" : "建立帳號"}
          </button>
        </form>
        {demo && (
          <p className="auth-switch" style={{ marginTop: 12 }}>
            示範模式:輸入任意帳號密碼即可登入
          </p>
        )}
        <p className="auth-switch">
          {mode === "login" ? "還沒有帳號?" : "已經有帳號了?"}
          <button
            type="button"
            onClick={() => {
              setMode(mode === "login" ? "register" : "login");
              setError("");
            }}
          >
            {mode === "login" ? "註冊新帳號" : "改為登入"}
          </button>
        </p>
      </section>
    </div>
  );
}
