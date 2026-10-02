import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, setCsrf, setUnauthorizedHandler } from './api';

export interface User { id: string; name: string; email: string; role: 'ADMIN' | 'MANAGER' | 'ACCOUNTANT' | 'VIEWER' }
interface Session { user: User | null; permissions: string[]; loading: boolean; can: (p: string) => boolean; login: (email: string, password: string) => Promise<void>; logout: () => Promise<void> }

const Ctx = createContext<Session>(null as unknown as Session);
export const useSession = () => useContext(Ctx);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  const apply = useCallback((r: { user: User; permissions: string[]; csrfToken: string } | null) => {
    setCsrf(r?.csrfToken ?? ''); setUser(r?.user ?? null); setPermissions(r?.permissions ?? []);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => apply(null));
    api.get('/api/auth/me').then(apply).catch(() => apply(null)).finally(() => setLoading(false));
  }, [apply]);

  const value = useMemo<Session>(() => ({
    user, permissions, loading, can: (p) => permissions.includes(p),
    login: async (email, password) => apply(await api.post('/api/auth/login', { email, password })),
    logout: async () => { try { await api.post('/api/auth/logout'); } finally { apply(null); } },
  }), [user, permissions, loading, apply]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
