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
  loading: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  setVisitor: (v: api.MeVisitor | null) => void;
}

const AuthContext = createContext<AuthState | null>(null);

/**
 * Holds the signed-in visitor across guest screens. The access token itself lives in
 * `api/client.ts`'s module state (memory only, SDD §9.5) — on mount this tries
 * `GET /me`, which (via the client's 401 -> refresh -> retry logic) picks up an
 * existing session from the httpOnly refresh cookie if the guest reloads the page.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [visitor, setVisitor] = useState<api.MeVisitor | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const me = await api.getMe();
      setVisitor(me);
    } catch {
      setVisitor(null);
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
  }, []);

  const value = useMemo(
    () => ({ visitor, loading, refresh, signOut, setVisitor }),
    [visitor, loading, refresh, signOut],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
