import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { useSession } from '../auth';
import { fmtDateTime } from '../format';
import { MyReminderPreference, RemindersCard } from './Reminders';
import { Badge, Card, ConfirmButton, Empty, Field, Loaded, Modal, Note, Page, StatusBadge, useAction, useLoad, useToast } from '../ui';

const ROLES = ['ADMIN', 'MANAGER', 'ACCOUNTANT', 'VIEWER'];
const ROLE_HELP: Record<string, string> = { ADMIN: 'Everything, including users', MANAGER: 'Everything except users', ACCOUNTANT: 'Expenses, imports, review, audit log', VIEWER: 'Read-only' };

function ChangePassword() {
  const [cur, setCur] = useState(''); const [next, setNext] = useState('');
  const { busy, error, run } = useAction();
  const toast = useToast();
  const submit = async (e: FormEvent) => { e.preventDefault(); if (await run(async () => { await api.post('/api/auth/change-password', { currentPassword: cur, newPassword: next }); return true; })) { toast('Password changed. Other sessions were signed out.'); setCur(''); setNext(''); } };
  return (<Card title="Change password"><form onSubmit={submit} style={{ maxWidth: 420, display: 'flex', flexDirection: 'column', gap: 12 }}>
    {error && <div className="alert bad" role="alert">{error}</div>}
    <Field label="Current password"><input type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} required /></Field>
    <Field label="New password" hint="At least 12 characters. A passphrase works well."><input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={12} /></Field>
    <div><button className="btn primary" disabled={busy}>Change password</button></div></form></Card>);
}

function Users() {
  const { user } = useSession();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [reset, setReset] = useState<any>(null);
  const q = useLoad(() => api.get('/api/users'), []);
  const { error, run } = useAction();
  const [nv, setNv] = useState({ name: '', email: '', role: 'MANAGER', password: '' });
  const [pw, setPw] = useState('');
  const patch = async (id: string, body: object) => { if (await run(async () => { await api.patch(`/api/users/${id}`, body); return true; })) { toast('User updated'); q.reload(); } };
  return (<Card title="Users" actions={<button className="btn primary sm" onClick={() => setAdding(true)}>Add user</button>} flush>
    {error && <div className="alert bad" role="alert" style={{ margin: 14 }}>{error}</div>}
    <Loaded q={q}>{(d) => <table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th /></tr></thead><tbody>
      {d.users.map((u: any) => <tr key={u.id}><td>{u.name}{u.id === user?.id && <> <Badge>you</Badge></>} {u.mfaEnabled ? <Badge tone="good">2FA</Badge> : <Badge tone="neutral">No 2FA</Badge>}</td><td>{u.email}</td>
        <td><select value={u.role} disabled={u.id === user?.id} onChange={(e) => patch(u.id, { role: e.target.value })} aria-label={`Role for ${u.name}`} style={{ width: 'auto' }}>{ROLES.map((r) => <option key={r} value={r}>{r.charAt(0) + r.slice(1).toLowerCase()}</option>)}</select></td>
        <td><StatusBadge status={u.active ? 'ACTIVE' : 'INACTIVE'} />{u.lockedUntil && new Date(u.lockedUntil) > new Date() && <> <Badge tone="warn">Locked</Badge></>}</td>
        <td className="r"><button className="btn sm" onClick={() => setReset(u)}>Reset password</button> {u.mfaEnabled && u.id !== user?.id && <><ConfirmButton className="btn sm" label="Reset 2FA" confirm={`Remove two-factor login for ${u.name}? They will be signed out and can set it up again.`} onConfirm={async () => { if (await run(async () => { await api.post(`/api/users/${u.id}/mfa/reset`); return true; })) { toast('Two-factor login reset'); q.reload(); } }} /> </>}{u.id !== user?.id && <button className="btn sm" onClick={() => patch(u.id, { active: !u.active })}>{u.active ? 'Deactivate' : 'Reactivate'}</button>}</td></tr>)}</tbody></table>}</Loaded>
    <div style={{ padding: '10px 18px' }} className="muted small">{ROLES.map((r) => <div key={r}><b>{r.charAt(0) + r.slice(1).toLowerCase()}:</b> {ROLE_HELP[r]}</div>)}</div>
    {adding && <Modal title="Add user" onClose={() => setAdding(false)}><form onSubmit={async (e) => { e.preventDefault(); if (await run(async () => { await api.post('/api/users', nv); return true; })) { setAdding(false); toast('User added'); q.reload(); setNv({ name: '', email: '', role: 'MANAGER', password: '' }); } }}>
      {error && <div className="alert bad" role="alert">{error}</div>}
      <div className="form-grid"><Field label="Name"><input value={nv.name} onChange={(e) => setNv({ ...nv, name: e.target.value })} required /></Field><Field label="Email"><input type="email" value={nv.email} onChange={(e) => setNv({ ...nv, email: e.target.value })} required /></Field>
        <Field label="Role"><select value={nv.role} onChange={(e) => setNv({ ...nv, role: e.target.value })}>{ROLES.map((r) => <option key={r} value={r}>{r.charAt(0) + r.slice(1).toLowerCase()}</option>)}</select></Field>
        <Field label="Temporary password" hint="At least 12 characters"><input type="password" autoComplete="new-password" value={nv.password} onChange={(e) => setNv({ ...nv, password: e.target.value })} required minLength={12} /></Field></div>
      <div className="form-actions"><button type="button" className="btn" onClick={() => setAdding(false)}>Cancel</button><button className="btn primary">Add user</button></div></form></Modal>}
    {reset && <Modal title={`Reset password: ${reset.name}`} onClose={() => { setReset(null); setPw(''); }}><form onSubmit={async (e) => { e.preventDefault(); if (await run(async () => { await api.post(`/api/users/${reset.id}/password`, { newPassword: pw }); return true; })) { toast('Password reset. Their sessions were signed out.'); setReset(null); setPw(''); } }}>
      <Field label="New password" hint="At least 12 characters"><input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} required minLength={12} /></Field>
      <div className="form-actions"><button type="button" className="btn" onClick={() => setReset(null)}>Cancel</button><button className="btn primary">Reset password</button></div></form></Modal>}
  </Card>);
}

export function SettingsPage() {
  const { user, can } = useSession();
  const cats = useLoad(() => api.get('/api/expense-categories'), []);
  return (
    <Page title="Settings">
      <Card title="Your account"><dl className="dl"><dt>Name</dt><dd>{user?.name}</dd><dt>Email</dt><dd>{user?.email}</dd><dt>Role</dt><dd>{user?.role}</dd></dl><div style={{ marginTop: 14 }}><MyReminderPreference /></div></Card>
      <ChangePassword />
      {can('settings:view') && <RemindersCard />}
      {can('users:manage') ? <Users /> : <Note>User management is available to administrators.</Note>}
      <Card title="Expense categories"><Loaded q={cats}>{(d) => <div className="chips" style={{ marginBottom: 0 }}>{d.categories.map((c: any) => <span className="chip" key={c.id}>{c.name}</span>)}</div>}</Loaded><p className="muted small" style={{ marginBottom: 0 }}>Type a new name when adding an expense to create a custom category.</p></Card>
    </Page>
  );
}

const ENTITY_TYPES = ['', 'expense', 'owner', 'property', 'owner_statement', 'accounting_period', 'import_batch', 'user'];

export function AuditLog() {
  const [type, setType] = useState('');
  const [entityId, setEntityId] = useState('');
  const q = useLoad(() => api.get(`/api/audit?limit=300${type ? `&entityType=${type}` : ''}${entityId ? `&entityId=${encodeURIComponent(entityId)}` : ''}`), [type, entityId]);
  const [verify, setVerify] = useState<any>(null);
  const { busy, run } = useAction();
  return (
    <Page title="Audit log" sub="Append-only record of every financial action" actions={<button className="btn" disabled={busy} onClick={async () => setVerify(await run(() => api.get('/api/audit/verify')))}>Verify log integrity</button>}>
      {verify && (verify.intact ? <Note tone="good">The audit trail is intact: no entry has been altered or removed.</Note> : <Note tone="bad">Integrity check failed at entry #{verify.firstBrokenId}. The audit log may have been tampered with.</Note>)}
      <div className="toolbar"><label className="inline-field"><span>Type</span><select value={type} onChange={(e) => setType(e.target.value)}>{ENTITY_TYPES.map((t) => <option key={t} value={t}>{t ? t.replace(/_/g, ' ') : 'All'}</option>)}</select></label>
        <label className="inline-field"><span>Object ID</span><input value={entityId} onChange={(e) => setEntityId(e.target.value.trim())} style={{ width: 300 }} placeholder="optional" /></label></div>
      <Loaded q={q}>{(d) => <Card flush>{d.entries.length === 0 ? <Empty>No entries.</Empty> : <table><thead><tr><th>When</th><th>User</th><th>Action</th><th>Object</th><th>Details</th></tr></thead><tbody>
        {d.entries.map((a: any) => <tr key={a.id}><td className="nowrap">{fmtDateTime(a.at)}</td><td>{a.userName ?? <span className="muted">System / owner link</span>}</td><td>{a.action.replace(/_/g, ' ').toLowerCase()}</td><td className="small">{a.entityType.replace(/_/g, ' ')}<div className="muted">{a.entityId.slice(0, 8)}</div></td>
          <td>{(a.oldValue || a.newValue) && <details><summary className="small" style={{ cursor: 'pointer' }}>View change</summary><pre className="small" style={{ whiteSpace: 'pre-wrap', maxWidth: 420, margin: '6px 0 0' }}>{a.oldValue ? `Before: ${JSON.stringify(a.oldValue, null, 1)}\n` : ''}{a.newValue ? `After: ${JSON.stringify(a.newValue, null, 1)}` : ''}</pre></details>}</td></tr>)}</tbody></table>}</Card>}</Loaded>
    </Page>
  );
}
