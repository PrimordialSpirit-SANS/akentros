import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { SessionProvider, useSession } from "./components/session";
import { StateBlock } from "./components/ui";
import { ConsoleLayout } from "./pages/ConsoleLayout";
import { DocsPage } from "./pages/DocsPage";
import { KeysPage } from "./pages/KeysPage";
import { LoginPage } from "./pages/LoginPage";
import { LogsPage } from "./pages/LogsPage";
import { ModelsPage } from "./pages/ModelsPage";
import { OverviewPage } from "./pages/OverviewPage";
import { PlaygroundPage } from "./pages/PlaygroundPage";
import { isBeaconDemoActive } from "./services/demoApi";

function LoginRoute() {
  const { user, loading, setUser } = useSession();
  if (loading) {
    return (
      <div className="auth-wrap">
        <StateBlock spinner>正在確認登入狀態…</StateBlock>
      </div>
    );
  }
  if (user) return <Navigate to="/" replace />;
  return <LoginPage onAuthenticated={setUser} />;
}

// 舊平台深連結(/Developer/ai-api/*)轉址到新路由,確保既有書籤可用。
const LEGACY_PAGE_MAP: Record<string, string> = {
  "": "/",
  keys: "/keys",
  test: "/playground",
  docs: "/docs",
  models: "/models",
  providers: "/models",
  logs: "/logs",
};

function LegacyDeveloperRedirect() {
  const { pathname } = useLocation();
  const page = pathname.replace(/^\/Developer\/ai-api\/?/, "").replace(/\/+$/, "");
  return <Navigate to={LEGACY_PAGE_MAP[page] ?? "/"} replace />;
}

function DemoModeBadge() {
  if (!isBeaconDemoActive()) return null;
  return (
    <div className="demo-badge" role="note">
      示範模式・未連接後端
    </div>
  );
}

export default function App() {
  return (
    <SessionProvider>
      <Routes>
        <Route path="/login" element={<LoginRoute />} />
        <Route path="/" element={<ConsoleLayout />}>
          <Route index element={<OverviewPage />} />
          <Route path="keys" element={<KeysPage />} />
          <Route path="playground" element={<PlaygroundPage />} />
          <Route path="models" element={<ModelsPage />} />
          <Route path="logs" element={<LogsPage />} />
          <Route path="docs" element={<DocsPage />} />
        </Route>
        <Route path="/Developer" element={<Navigate to="/" replace />} />
        <Route path="/Developer/ai-api/*" element={<LegacyDeveloperRedirect />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <DemoModeBadge />
    </SessionProvider>
  );
}
