import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, setToken, getToken, ApiError } from './api';

export type UserRole =
  | 'OWNER_ADMIN'
  | 'ACCOUNTS'
  | 'SALES_COUNTER'
  | 'PRODUCTION_MANAGER'
  | 'OPERATOR'
  | 'DELIVERY';

export type Action = 'C' | 'R' | 'U' | 'D' | 'A';

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
}

export interface SessionTenant {
  id: string;
  legalName: string;
  tradeName?: string | null;
  gstin?: string | null;
  homeStateCode?: string | null;
  status: string;
  goLiveReady: boolean;
  wizardStep?: string | null;
}

export interface SessionBranch {
  id: string;
  branchCode: string;
  name: string;
  stateCode: string;
  isHeadOffice: boolean;
}

export interface Session {
  user: SessionUser;
  tenant: SessionTenant;
  branches: SessionBranch[];
  permissions: Record<string, Action[]>;
  subscription?: { status: string; planCode?: string; seats?: number; seatsUsed?: number; trialEndsAt?: string | null };
}

interface AuthValue {
  session: Session | null;
  loading: boolean;
  /** FR-716 — the client hides what the server would deny anyway. */
  can: (module: string, action: Action) => boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (payload: RegisterPayload) => Promise<void>;
  logout: () => void;
  refresh: () => Promise<void>;
}

export interface RegisterPayload {
  legalName: string;
  tradeName?: string;
  ownerName: string;
  email: string;
  password: string;
  phone?: string;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!getToken()) {
      setSession(null);
      setLoading(false);
      return;
    }
    try {
      const me = await api.get<Session>('/auth/me');
      setSession(me);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        setToken(null);
        setSession(null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(
    async (email: string, password: string) => {
      const res = await api.post<{ token: string }>('/auth/login', { email, password });
      setToken(res.token);
      await refresh();
    },
    [refresh],
  );

  const register = useCallback(
    async (payload: RegisterPayload) => {
      const res = await api.post<{ token: string }>('/auth/register', payload);
      setToken(res.token);
      await refresh();
    },
    [refresh],
  );

  const logout = useCallback(() => {
    setToken(null);
    setSession(null);
  }, []);

  const can = useCallback(
    (module: string, action: Action) => (session?.permissions?.[module] ?? []).includes(action),
    [session],
  );

  const value = useMemo<AuthValue>(
    () => ({ session, loading, can, login, register, logout, refresh }),
    [session, loading, can, login, register, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
