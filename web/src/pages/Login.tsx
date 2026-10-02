import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useSession } from '../auth';
import { useAction } from '../ui';

export function Login() {
  const { user, login } = useSession();
  const nav = useNavigate();
  const loc = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { busy, error, run } = useAction();
  const to = (loc.state as { from?: string } | null)?.from ?? '/';
  if (user) return <Navigate to={to} replace />;
  const submit = async (e: FormEvent) => { e.preventDefault(); const ok = await run(async () => { await login(email, password); return true; }); if (ok) nav(to, { replace: true }); };
  return (
    <div className="login-wrap">
      <div className="login">
        <span className="brand-mark" style={{ display: 'inline-grid', width: 36, height: 36, borderRadius: 9, background: '#0f766e', placeItems: 'center' }}>
          <svg width="20" height="20" viewBox="0 0 32 32"><path d="M7 22l6-6 4 4 8-9" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </span>
        <h1>Owner Accounting</h1>
        <p className="muted" style={{ margin: 0 }}>Sign in to manage statements and owner reporting.</p>
        <form onSubmit={submit}>
          {error && <div className="alert bad" role="alert">{error}</div>}
          <label className="field"><span>Email</span><input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></label>
          <label className="field"><span>Password</span><input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
          <button className="btn primary" disabled={busy} style={{ justifyContent: 'center' }}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
      </div>
    </div>
  );
}
