import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, setCsrf, setMfaRequiredHandler, setUnauthorizedHandler } from './api';

export interface User { id: string; name: string; email: string; role: 'ADMIN' | 'MANAGER' | 'ACCOUNTANT' | 'VIEWER' }
export interface MfaInfo { enabled: boolean; enrollmentRequired: boolean }
interface Session { user: User | null; permissions: string[]; mfa: MfaInfo; loading: boolean; can: (p: string) => boolean;
  /** Resolves with a challenge token when a second factor is needed, otherwise signs in and resolves null. */
  login: (email: string, password: string) => Promise<string | null>; verifyMfa: (challenge: string, code: string) => Promise<void>; refresh: () => Promise<void>; logout: () => Promise<void> }

const Ctx = createContext<Session>(null as unknown as Session);
export const useSession = () => useContext(Ctx);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [mfa, setMfa] = useState<MfaInfo>({ enabled: false, enrollmentRequired: false });
  const [loading, setLoading] = useState(true);

  const apply = useCallback((r: { user: User; permissions: string[]; csrfToken: string; mfa?: MfaInfo } | null) => {
    setCsrf(r?.csrfToken ?? ''); setUser(r?.user ?? null); setPermissions(r?.permissions ?? []); setMfa(r?.mfa ?? { enabled: false, enrollmentRequired: false });
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => apply(null));
    setMfaRequiredHandler(() => setMfa({ enabled: false, enrollmentRequired: true }));
    api.get('/api/auth/me').then(apply).catch(() => apply(null)).finally(() => setLoading(false));
  }, [apply]);

  const value = useMemo<Session>(() => ({
    user, permissions, mfa, loading, can: (p) => permissions.includes(p),
    login: async (email, password) => {
      const r = await api.post('/api/auth/login', { email, password });
      if (r.mfaRequired) return r.challenge as string;
      apply(r); return null;
    },
    verifyMfa: async (challenge, code) => apply(await api.post('/api/auth/mfa/verify', { challenge, code })),
    refresh: async () => { apply(await api.get('/api/auth/me')); },
    logout: async () => { try { await api.post('/api/auth/logout'); } finally { apply(null); } },
  }), [user, permissions, mfa, loading, apply]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
