import React from "react";
import { Navigate, NavLink, Outlet, useNavigate } from "react-router-dom";
import { AkentrosIcon } from "../components/AkentrosIcon";
import { useSession } from "../components/session";
import { StateBlock } from "../components/ui";
import { logoutAkentrosAccount } from "../lib/akentros/api/akentrosAuthApi";
import { formatUsd } from "../lib/akentros/utils/formatAkentros";

// 控制台外框:側邊欄 + Outlet。未登入時導向 /login。

function NavIcon({ name }: { name: "overview" | "play" | "key" | "cube" | "list" | "book" }) {
  const paths: Record<string, React.ReactNode> = {
    overview: (
      <>
        <rect x="3" y="3" width="8" height="10" rx="1.5" />
        <rect x="13" y="3" width="8" height="6" rx="1.5" />
        <rect x="13" y="13" width="8" height="8" rx="1.5" />
        <rect x="3" y="17" width="8" height="4" rx="1.5" />
      </>
    ),
    play: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="m10 8.5 5 3.5-5 3.5Z" />
      </>
    ),
    key: (
      <>
        <circle cx="8" cy="15" r="4" />
        <path d="m11 12 9-9M16 7l3 3M14 9l3 3" />
      </>
    ),
    cube: (
      <>
        <path d="m12 2 8 4.5v9L12 20l-8-4.5v-9Z" />
        <path d="M12 11 4 6.5M12 11l8-4.5M12 11v9" />
      </>
    ),
    list: (
      <>
        <path d="M8 6h13M8 12h13M8 18h13" />
        <circle cx="3.5" cy="6" r="1" />
        <circle cx="3.5" cy="12" r="1" />
        <circle cx="3.5" cy="18" r="1" />
      </>
    ),
    book: (
      <>
        <path d="M4 5.5A3.5 3.5 0 0 1 7.5 2H20v17H7.5A3.5 3.5 0 0 0 4 22.5Z" />
        <path d="M4 5.5v17M8 7h8M8 11h6" />
      </>
    ),
  };
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

const NAV_GROUPS: Array<{
  label: string;
  items: Array<{ to: string; label: string; icon: "overview" | "play" | "key" | "cube" | "list" | "book" }>;
}> = [
  {
    label: "使用",
    items: [
      { to: "/", label: "總覽", icon: "overview" },
      { to: "/playground", label: "串流測試", icon: "play" },
    ],
  },
  {
    label: "資源",
    items: [
      { to: "/keys", label: "API 金鑰", icon: "key" },
      { to: "/models", label: "模型", icon: "cube" },
      { to: "/logs", label: "請求紀錄", icon: "list" },
    ],
  },
  {
    label: "文件",
    items: [{ to: "/docs", label: "快速開始", icon: "book" }],
  },
];

export function ConsoleLayout() {
  const { user, loading, setUser } = useSession();
  const navigate = useNavigate();

  if (loading) {
    return (
      <div className="auth-wrap">
        <StateBlock spinner>正在確認登入狀態…</StateBlock>
      </div>
    );
  }
  if (!user) {
    return <Navigate to="/login" replace />;
  }

  const logout = async () => {
    try {
      await logoutAkentrosAccount();
    } finally {
      // 先清空 context,否則 /login 會因為殘留的 session 被彈回控制台。
      setUser(null);
      navigate("/login", { replace: true });
    }
  };

  return (
    <div className="shell">
      <aside className="sidebar">
        <NavLink className="sidebar-brand" to="/">
          <AkentrosIcon size={24} />
          <strong>Akentros</strong>
          <small>CONSOLE</small>
        </NavLink>
        <nav className="sidebar-nav" aria-label="控制台導覽">
          {NAV_GROUPS.map((group) => (
            <React.Fragment key={group.label}>
              <span className="nav-group">{group.label}</span>
              {group.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === "/"}
                  className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}
                >
                  <NavIcon name={item.icon} />
                  <span>{item.label}</span>
                </NavLink>
              ))}
            </React.Fragment>
          ))}
        </nav>
        <div className="sidebar-user">
          <span className="sidebar-user-avatar" aria-hidden="true">
            {(user.display_name || user.username || "?").slice(0, 1).toUpperCase()}
          </span>
          <span className="sidebar-user-meta">
            <strong>{user.display_name || user.username}</strong>
            <span>餘額 {formatUsd(user.balance_usd)}</span>
          </span>
          <button type="button" className="sidebar-logout" onClick={() => void logout()} aria-label="登出">
            登出
          </button>
        </div>
      </aside>
      <main className="main">
        <div className="main-inner">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
