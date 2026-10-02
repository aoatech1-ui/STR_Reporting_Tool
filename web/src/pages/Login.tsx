import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useSession } from '../auth';
import { useAction } from '../ui';

export function Login() {
  const { user, login, verifyMfa } = useSession();
  const nav = useNavigate();
  const loc = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  const { busy, error, run, setError } = useAction();
  const to = (loc.state as { from?: string } | null)?.from ?? '/';
  if (user) return <Navigate to={to} replace />;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await run(async () => ({ challenge: await login(email, password) }));
    if (!r) return;
    if (r.challenge) { setChallenge(r.challenge); setPassword(''); } else nav(to, { replace: true });
  };
  const submitCode = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await run(async () => { await verifyMfa(challenge!, code); return true; });
    if (ok) nav(to, { replace: true }); else setCode('');
  };
  const back = () => { setChallenge(null); setCode(''); setError(null); };
  return (
    <div className="login-wrap">
      <div className="login">
        <span className="brand-mark" style={{ display: 'inline-grid', width: 36, height: 36, borderRadius: 9, background: '#0f766e', placeItems: 'center' }}>
          <svg width="20" height="20" viewBox="0 0 32 32"><path d="M7 22l6-6 4 4 8-9" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </span>
        <h1>Owner Accounting</h1>
        {!challenge ? (<>
          <p className="muted" style={{ margin: 0 }}>Sign in to manage statements and owner reporting.</p>
          <form onSubmit={submit}>
            {error && <div className="alert bad" role="alert">{error}</div>}
            <label className="field"><span>Email</span><input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></label>
            <label className="field"><span>Password</span><input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
            <button className="btn primary" disabled={busy} style={{ justifyContent: 'center' }}>{busy ? 'Signing in…' : 'Sign in'}</button>
          </form>
        </>) : (<>
          <p className="muted" style={{ margin: 0 }}>{recovery ? 'Enter one of your recovery codes. Each works once.' : 'Enter the 6-digit code from your authenticator app.'}</p>
          <form onSubmit={submitCode}>
            {error && <div className="alert bad" role="alert">{error}</div>}
            <label className="field"><span>{recovery ? 'Recovery code' : 'Authentication code'}</span>
              {recovery
                ? <input key="rc" type="text" autoComplete="off" spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} placeholder="XXXXX-XXXXX" required autoFocus />
                : <input key="otp" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" required autoFocus />}
            </label>
            <button className="btn primary" disabled={busy} style={{ justifyContent: 'center' }}>{busy ? 'Verifying…' : 'Verify and sign in'}</button>
            <button type="button" className="btn ghost sm" onClick={() => { setRecovery(!recovery); setCode(''); setError(null); }} style={{ justifyContent: 'center' }}>{recovery ? 'Use my authenticator app instead' : 'Use a recovery code instead'}</button>
            <button type="button" className="btn ghost sm" onClick={back} style={{ justifyContent: 'center' }}>Back to sign in</button>
          </form>
        </>)}
      </div>
    </div>
  );
}
