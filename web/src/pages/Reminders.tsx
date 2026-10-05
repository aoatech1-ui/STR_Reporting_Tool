import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useSession } from '../auth';
import { fmtDate, fmtDateTime } from '../format';
import { Badge, Card, Field, Loaded, Note, useAction, useLoad, useToast, type Tone } from '../ui';

const STATE: Record<string, { icon: string; tone: Tone; label: string }> = {
  done: { icon: '✓', tone: 'good', label: 'Done' }, todo: { icon: '○', tone: 'neutral', label: 'To do' },
  warn: { icon: '!', tone: 'warn', label: 'Needs attention' }, later: { icon: '–', tone: 'neutral', label: 'Later' },
};

/** Live month-end checklist: the same items the reminder emails contain. */
export function LiveChecklist({ ym, version }: { ym: string; version: unknown }) {
  const q = useLoad(() => api.get(`/api/close/checklist?ym=${ym}`), [ym, version]);
  const link: Record<string, string> = { import: '/import', expenses: `/expenses?ym=${ym}`, send: '/communications' };
  return (<Loaded q={q}>{(d) => (
    <ul className="checklist" aria-label="Month-end checklist">
      {d.items.map((i: any) => <li key={i.key} className={`ck ${i.state}`}>
        <span className={`ck-icon ${STATE[i.state].tone}`} aria-label={STATE[i.state].label}>{STATE[i.state].icon}</span>
        <div><div className="ck-title">{link[i.key] && i.state !== 'done' ? <Link to={link[i.key]}>{i.title}</Link> : i.title}</div><div className="muted small">{i.detail}</div></div>
      </li>)}
    </ul>)}</Loaded>);
}

export function MyReminderPreference() {
  const q = useLoad(() => api.get('/api/me/preferences'), []);
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => { if (q.data) setOn(q.data.monthEndReminders); }, [q.data]);
  const toast = useToast();
  const { run, error } = useAction();
  const change = async (next: boolean) => {
    setOn(next); // optimistic; reverted if the server refuses
    if (await run(() => api.put('/api/me/preferences', { monthEndReminders: next }))) toast(next ? 'You will get month-end reminders' : 'Month-end reminders turned off for you');
    else setOn(!next);
  };
  return (<Loaded q={q}>{() => (<>
    {error && <div className="alert bad" role="alert">{error}</div>}
    <label className="field check"><input type="checkbox" checked={!!on} onChange={(e) => change(e.target.checked)} /><span>Email me month-end reminders (when they are on for my role)</span></label></>)}</Loaded>);
}

const BEFORE = [-7, -5, -3, -2, -1];
const AFTER = [1, 2, 3, 5, 7, 10, 15];
const ROLES = ['ADMIN', 'MANAGER', 'ACCOUNTANT', 'VIEWER'];
const cap = (r: string) => r.charAt(0) + r.slice(1).toLowerCase();
const ord = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
const dayChip = (d: number) => (d === -1 ? 'Last day' : d < 0 ? `${-d} days before` : ord(d));
const hourLabel = (h: number) => `${h % 12 === 0 ? 12 : h % 12}:00 ${h < 12 ? 'AM' : 'PM'}`;
const zones = (() => { try { return (Intl as any).supportedValuesOf('timeZone') as string[]; } catch { return ['UTC']; } })();
const browserZone = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } })();
const zoned = (iso: string, tz: string) => { try { return new Date(iso).toLocaleString('en-US', { timeZone: tz, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch { return fmtDateTime(iso); } };
const RUN_TONE: Record<string, Tone> = { SENT: 'good', QUEUED: 'info', SKIPPED: 'neutral', FAILED: 'bad', MISSED: 'warn' };

export function RemindersCard() {
  const { can } = useSession();
  const edit = can('reminders:manage');
  const toast = useToast();
  const q = useLoad(() => api.get('/api/settings/reminders'), []);
  const { busy, error, run } = useAction();
  const [f, setF] = useState<any>(null);
  useEffect(() => {
    if (!q.data) return;
    const s = q.data.settings;
    setF({ enabled: s.enabled, timezone: s.updatedAt ? s.timezone : browserZone, sendHour: s.sendHour, days: s.days, dueDay: s.dueDay, roles: s.roles });
  }, [q.data]);
  const toggleDay = (d: number) => setF({ ...f, days: f.days.includes(d) ? f.days.filter((x: number) => x !== d) : [...f.days, d].sort((a: number, b: number) => a - b) });
  const save = async () => { if (await run(() => api.put('/api/settings/reminders', f))) { toast('Reminder schedule saved'); q.reload(); } };
  const test = async () => { const r = await run(() => api.post('/api/settings/reminders/test')); if (r) { toast(`Test reminder queued for ${r.sendsTo}`); setTimeout(q.reload, 2500); } };

  return (<Card title={<>Month-end reminders {q.data && (q.data.settings.enabled ? <Badge tone="good">On</Badge> : <Badge>Off</Badge>)}</>}>
    <Loaded q={q}>{(d) => !f ? null : (<>
      <p className="muted" style={{ marginTop: 0 }}>Emails your team a checklist of what is still open for the month: Airbnb import, expenses and receipts, review, finalizing and sending.
        Reminders only report. Nothing is finalized or sent to owners automatically, and a month that is already finalized and sent is skipped.</p>
      {!d.emailConfigured && <Note tone="warn">No email provider is configured, so reminders cannot be sent. See Integrations.</Note>}
      {d.emailConfigured && !d.workerActive && d.settings.enabled && <Note tone="warn">The background worker is not running. Reminders are sent by the worker.</Note>}
      {error && <div className="alert bad" role="alert">{error}</div>}
      <fieldset disabled={!edit} style={{ border: 0, padding: 0, margin: 0 }}>
        <label className="field check"><input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /><span>Send month-end reminders</span></label>
        <div className="reminder-days" role="group" aria-label="Before month end">
          <span className="muted small">Before month end</span>
          {[...new Set([...BEFORE, ...f.days.filter((x: number) => x < 0)])].sort((a, b) => a - b).map((x) => <button type="button" key={x} className={`chip-btn ${f.days.includes(x) ? 'on' : ''}`} aria-pressed={f.days.includes(x)} onClick={() => toggleDay(x)}>{dayChip(x)}</button>)}
        </div>
        <div className="reminder-days" role="group" aria-label="Day of the next month">
          <span className="muted small">Day of the next month</span>
          {[...new Set([...AFTER, ...f.days.filter((x: number) => x > 0)])].sort((a, b) => a - b).map((x) => <button type="button" key={x} className={`chip-btn ${f.days.includes(x) ? 'on' : ''}`} aria-pressed={f.days.includes(x)} onClick={() => toggleDay(x)}>{dayChip(x)}</button>)}
        </div>
        <div className="form-grid" style={{ marginTop: 12 }}>
          <Field label="Send at"><select value={f.sendHour} onChange={(e) => setF({ ...f, sendHour: Number(e.target.value) })}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}</select></Field>
          <Field label="Time zone"><select value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })}>{[...new Set([f.timezone, ...zones])].map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}</select></Field>
          <Field label="Statements due to owners by" hint="Shown in reminders; after it they say overdue"><select value={f.dueDay ?? ''} onChange={(e) => setF({ ...f, dueDay: e.target.value ? Number(e.target.value) : null })}>
            <option value="">No due date</option>{Array.from({ length: 28 }, (_, i) => <option key={i + 1} value={i + 1}>{ord(i + 1)} of the next month</option>)}</select></Field>
          <div className="field"><span>Who receives them</span><div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', paddingTop: 6 }}>{ROLES.map((r) => <label key={r} className="field check"><input type="checkbox" checked={f.roles.includes(r)} onChange={(e) => setF({ ...f, roles: e.target.checked ? [...f.roles, r] : f.roles.filter((x: string) => x !== r) })} /><span>{cap(r)}</span></label>)}</div></div>
        </div>
      </fieldset>
      {edit && <div className="actions" style={{ marginTop: 14 }}><button className="btn primary" disabled={busy} onClick={save}>Save schedule</button><button className="btn" disabled={busy || !d.emailConfigured} onClick={test}>Send me a test</button></div>}

      <div className="grid k2" style={{ marginTop: 18 }}>
        <div><h3 className="h3">Next reminders</h3>{d.upcoming.length ? <><ul className="plain">{d.upcoming.map((u: any) => <li key={u.at}><b>{fmtDate(u.localDate)}, {hourLabel(d.settings.sendHour)}</b> <span className="muted small">{u.month} · {u.when}</span></li>)}</ul>
          <p className="muted small">Times are {d.settings.timezone.replace(/_/g, ' ')} time.</p></> : <p className="muted small">None scheduled{d.settings.enabled ? '' : ': reminders are off'}.</p>}</div>
        <div><h3 className="h3">Recipients ({d.recipients.length})</h3>{d.recipients.length ? <ul className="plain">{d.recipients.map((r: any) => <li key={r.email}>{r.name} <span className="muted small">{r.email}</span></li>)}</ul> : <p className="muted small">Nobody: no active user with these roles has reminders on.</p>}<p className="muted small">People can turn reminders off for themselves under Your account.</p></div>
      </div>

      <h3 className="h3" style={{ marginTop: 18 }}>History</h3>
      {d.runs.length === 0 ? <p className="muted small">No reminders sent yet.</p> : <div className="scroll-x"><table><thead><tr><th>Scheduled</th><th>Month</th><th>Reminder</th><th>Status</th><th>Detail</th></tr></thead><tbody>
        {d.runs.map((r: any) => <tr key={r.id}><td>{zoned(r.scheduledFor, d.settings.timezone)}</td><td>{r.monthLabel}</td><td>{r.when}</td><td><Badge tone={RUN_TONE[r.status] ?? 'neutral'}>{cap(r.status)}</Badge></td>
          <td className="small">{r.status === 'SENT' ? `${r.sentTo.length} recipient${r.sentTo.length === 1 ? '' : 's'}` : r.reason ?? ''}</td></tr>)}</tbody></table></div>}
    </>)}</Loaded>
  </Card>);
}
