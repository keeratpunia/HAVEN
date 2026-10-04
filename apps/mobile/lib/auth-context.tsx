import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import * as api from '../api/client.js';

interface AuthState {
  visitor: api.MeVisitor | null;
  user: api.MeUser | null;
  loading: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  setVisitor: (v: api.MeVisitor | null) => void;
  setUser: (u: api.MeUser | null) => void;
}

const AuthContext = createContext<AuthState | null>(null);

/**
 * Holds the signed-in principal — guest visitor or resident user — across screens.
 * `GET /me` (via `api.getMe()`) returns whichever shape matches the access token's
 * principal type; this sets exactly one of `visitor`/`user` and nulls the other. The
 * access token itself lives in `api/client.ts`'s module state (memory only, SDD §9.5)
 * — on mount this tries `GET /me`, which (via the client's 401 -> refresh -> retry
 * logic) picks up an existing session from the httpOnly refresh cookie on reload.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [visitor, setVisitor] = useState<api.MeVisitor | null>(null);
  const [user, setUser] = useState<api.MeUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const me = await api.getMe();
      if (me.type === 'user') {
        setUser(me);
        setVisitor(null);
      } else {
        setVisitor(me);
        setUser(null);
      }
    } catch {
      setVisitor(null);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const signOut = useCallback(async () => {
    await api.logout().catch(() => undefined);
    api.setAccessToken(null);
    setVisitor(null);
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({ visitor, user, loading, refresh, signOut, setVisitor, setUser }),
    [visitor, user, loading, refresh, signOut],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
