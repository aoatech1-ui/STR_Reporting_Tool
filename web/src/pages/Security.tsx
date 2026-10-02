import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { useSession } from '../auth';
import { fmtDateTime } from '../format';
import { Badge, Card, Field, Loaded, Modal, Note, Page, useAction, useLoad, useToast } from '../ui';

/** Shown once after enrolment or regeneration. The server cannot show them again. */
function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [saved, setSaved] = useState(false);
  const toast = useToast();
  useEffect(() => { document.body.classList.add('print-codes'); return () => document.body.classList.remove('print-codes'); }, []); // print only the codes, and only while they are on screen
  const text = `Owner Accounting recovery codes\nEach code works once.\n\n${codes.join('\n')}\n`;
  const download = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' })); a.download = 'recovery-codes.txt'; a.click(); URL.revokeObjectURL(a.href); };
  return (<Card title="Save your recovery codes">
    <Note tone="warn">These are shown <b>only once</b>. If you lose your phone, each code lets you sign in one time. Keep them somewhere safe, such as a password manager.</Note>
    <ul className="recovery-codes" aria-label="Recovery codes">{codes.map((c) => <li key={c}><code>{c}</code></li>)}</ul>
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
      <button className="btn" onClick={async () => { try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Could not copy: select the codes manually', 'bad'); } }}>Copy</button>
      <button className="btn" onClick={download}>Download</button>
      <button className="btn" onClick={() => window.print()}>Print</button>
    </div>
    <label className="field check" style={{ marginTop: 14 }}><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /><span>I have saved these codes</span></label>
    <div style={{ marginTop: 12 }}><button className="btn primary" disabled={!saved} onClick={onDone}>Done</button></div>
  </Card>);
}

function Enroll({ onFinished }: { onFinished: (codes: string[]) => void }) {
  const [password, setPassword] = useState('');
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const { busy, error, run } = useAction();
  const start = async (e: FormEvent) => { e.preventDefault(); const r = await run(() => api.post('/api/mfa/enroll/start', { password })); if (r) { setSetup(r); setPassword(''); } };
  const confirm = async (e: FormEvent) => { e.preventDefault(); const r = await run(() => api.post('/api/mfa/enroll/confirm', { code })); if (r) onFinished(r.recoveryCodes); };
  if (!setup) return (<Card title="Turn on two-factor login">
    <p className="muted" style={{ marginTop: 0 }}>You will use an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy…) to get a 6-digit code at sign-in.</p>
    <form onSubmit={start} style={{ maxWidth: 420, display: 'flex', flexDirection: 'column', gap: 12 }}>
      {error && <div className="alert bad" role="alert">{error}</div>}
      <Field label="Confirm your password"><input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
      <div><button className="btn primary" disabled={busy}>Continue</button></div>
    </form></Card>);
  return (<Card title="Scan, then confirm">
    <ol style={{ margin: '0 0 14px', paddingLeft: 20 }}>
      <li>Scan this QR code with your authenticator app.</li>
      <li>Or type the key in by hand: <code className="secret-key" data-testid="totp-secret">{setup.secret}</code></li>
      <li>Enter the 6-digit code the app shows.</li>
    </ol>
    <div className="qr" role="img" aria-label="QR code for your authenticator app" dangerouslySetInnerHTML={{ __html: setup.qr }} />
    <form onSubmit={confirm} style={{ maxWidth: 320, display: 'flex', flexDirection: 'column', gap: 12, marginTop: 14 }}>
      {error && <div className="alert bad" role="alert">{error}</div>}
      <Field label="6-digit code"><input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} required autoFocus /></Field>
      <div><button className="btn primary" disabled={busy}>Turn on</button></div>
    </form></Card>);
}

function ManageModal({ kind, onClose, onCodes, onDisabled }: { kind: 'disable' | 'regenerate'; onClose: () => void; onCodes: (c: string[]) => void; onDisabled: () => void }) {
  const [password, setPassword] = useState(''); const [code, setCode] = useState('');
  const { busy, error, run } = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await run(() => api.post(kind === 'disable' ? '/api/mfa/disable' : '/api/mfa/recovery-codes', { password, code }));
    if (!r) return;
    if (kind === 'disable') onDisabled(); else onCodes(r.recoveryCodes);
  };
  return (<Modal title={kind === 'disable' ? 'Turn off two-factor login' : 'New recovery codes'} onClose={onClose}><form onSubmit={submit}>
    {error && <div className="alert bad" role="alert">{error}</div>}
    <p className="muted" style={{ marginTop: 0 }}>{kind === 'disable' ? 'Your account will be protected by your password only.' : 'Your current codes stop working as soon as new ones are created.'}</p>
    <div className="form-grid">
      <Field label="Password"><input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
      <Field label="Authenticator or recovery code"><input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" required /></Field>
    </div>
    <div className="form-actions"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className={`btn ${kind === 'disable' ? 'danger' : 'primary'}`} disabled={busy}>{kind === 'disable' ? 'Turn off' : 'Create new codes'}</button></div>
  </form></Modal>);
}

function Policy({ onChanged }: { onChanged: () => void }) {
  const { refresh } = useSession();
  const toast = useToast();
  const q = useLoad(() => api.get('/api/settings/security'), []);
  const { error, run } = useAction();
  const { can } = useSession();
  const put = async (requireMfa: boolean) => {
    if (await run(async () => { await api.put('/api/settings/security', { requireMfa }); return true; })) { toast(requireMfa ? 'Two-factor login is now required' : 'Two-factor login is no longer required'); q.reload(); onChanged(); await refresh(); }
  };
  return (<Card title="Organization policy">
    {error && <div className="alert bad" role="alert">{error}</div>}
    <Loaded q={q}>{(d) => (<>
      <p style={{ marginTop: 0 }}><b>{d.usersWithMfa}</b> of <b>{d.activeUsers}</b> active users have two-factor login. {d.requireMfa ? <Badge tone="good">Required for everyone</Badge> : <Badge>Optional</Badge>}</p>
      <p className="muted small">When required, anyone without two-factor login is taken straight to this page and can do nothing else until they set it up.</p>
      {can('users:manage') && <button className="btn" onClick={() => put(!d.requireMfa)}>{d.requireMfa ? 'Make optional' : 'Require for everyone'}</button>}
    </>)}</Loaded></Card>);
}

export function SecurityPage() {
  const { mfa, refresh, can } = useSession();
  const toast = useToast();
  const st = useLoad(() => api.get('/api/mfa/status'), [mfa.enabled]);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [modal, setModal] = useState<null | 'disable' | 'regenerate'>(null);
  const finish = async () => { setCodes(null); await refresh(); st.reload(); };
  return (<Page title="Security" sub="Two-factor login protects your account even if your password leaks.">
    {mfa.enrollmentRequired && <Note tone="warn">Your organization requires two-factor login. Set it up to continue.</Note>}
    {codes ? <RecoveryCodes codes={codes} onDone={finish} /> : (
      <Loaded q={st}>{(s) => !s.serverReady ? <Note tone="warn">Two-factor login is not available on this server yet. An administrator needs to set <code>MFA_ENCRYPTION_KEY</code>.</Note>
        : s.enabled ? (<Card title="Two-factor login"><dl className="dl"><dt>Status</dt><dd><Badge tone="good">On</Badge></dd><dt>Since</dt><dd>{s.enabledAt ? fmtDateTime(s.enabledAt) : ''}</dd><dt>Recovery codes</dt><dd>{s.recoveryCodesRemaining} unused{s.recoveryCodesRemaining <= 2 && <> <Badge tone="warn">running low</Badge></>}</dd></dl>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
            <button className="btn" onClick={() => setModal('regenerate')}>New recovery codes</button>
            {!s.orgRequires && <button className="btn danger" onClick={() => setModal('disable')}>Turn off</button>}
          </div></Card>)
          : <Enroll onFinished={(c) => { setCodes(c); void refresh(); }} />}</Loaded>)}
    {!mfa.enrollmentRequired && !codes && can('settings:view') && <Policy onChanged={st.reload} />}
    {modal && <ManageModal kind={modal} onClose={() => setModal(null)} onCodes={(c) => { setModal(null); setCodes(c); }} onDisabled={async () => { setModal(null); toast('Two-factor login turned off'); await refresh(); st.reload(); }} />}
  </Page>);
}
