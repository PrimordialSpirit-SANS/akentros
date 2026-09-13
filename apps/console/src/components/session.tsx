import React from "react";
import { fetchBeaconSession } from "../lib/beacon/api/beaconAuthApi";
import type { BeaconConsoleUser } from "../lib/beacon/types";

// 會話狀態:登入後的 user 由 context 共用;loading 期間由 ConsoleLayout 顯示 spinner。

interface SessionValue {
  user: BeaconConsoleUser | null;
  loading: boolean;
  setUser: (user: BeaconConsoleUser | null) => void;
  refresh: () => Promise<void>;
}

const SessionContext = React.createContext<SessionValue>({
  user: null,
  loading: true,
  setUser: () => {},
  refresh: async () => {},
});

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = React.useState<BeaconConsoleUser | null>(null);
  const [loading, setLoading] = React.useState(true);

  const refresh = React.useCallback(async () => {
    try {
      setUser(await fetchBeaconSession());
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = React.useMemo(() => ({ user, loading, setUser, refresh }), [user, loading, refresh]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  return React.useContext(SessionContext);
}
