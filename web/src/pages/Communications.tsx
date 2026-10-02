import { Link, useSearchParams } from 'react-router-dom';
import { api, qs } from '../api';
import { useSession } from '../auth';
import { fmtDateTime, fmtMonth, ymOf } from '../format';
import { Badge, Card, Empty, Loaded, Note, Page, StatusBadge, useAction, useLoad, useToast } from '../ui';

export function Communications() {
  const { can } = useSession();
  const toast = useToast();
  const [sp, setSp] = useSearchParams();
  const status = sp.get('status') ?? '';
  const q = useLoad(() => api.get(`/api/deliveries${qs({ status })}`), [status]);
  const { busy, error, run } = useAction();
  const resend = async (statementId: string) => { const r = await run(() => api.post(`/api/statements/${statementId}/send`, { resend: true })); if (r) { toast('Queued for delivery'); q.reload(); } };
  return (
    <Page title="Communications" sub="Every statement email and WhatsApp message, with delivery status">
      <div className="toolbar"><label className="inline-field"><span>Status</span><select value={status} onChange={(e) => setSp(e.target.value ? { status: e.target.value } : {})}><option value="">All</option>{['QUEUED', 'SENT', 'DELIVERED', 'BOUNCED', 'FAILED'].map((s) => <option key={s} value={s}>{s.charAt(0) + s.slice(1).toLowerCase()}</option>)}</select></label>
        <button className="btn sm" onClick={q.reload}>Refresh</button></div>
      {error && <div className="alert bad" role="alert">{error}</div>}
      <Loaded q={q}>{(d) => <Card flush>{d.deliveries.length === 0 ? <Empty>No messages{status ? ' with this status' : ' yet'}.</Empty> : (
        <table><thead><tr><th>Created</th><th>Statement</th><th>Owner</th><th>Channel</th><th>Recipient</th><th>Status</th><th>Attempts</th><th>Detail</th><th /></tr></thead><tbody>
          {d.deliveries.map((x: any) => <tr key={x.id}><td className="nowrap">{fmtDateTime(x.createdAt)}</td><td><Link to={`/statements/${x.statementId}`}>{fmtMonth(ymOf(x.year, x.month))}</Link><div className="muted small">{x.propertyName}</div></td><td>{x.ownerName}</td>
            <td>{x.channel === 'EMAIL' ? 'Email' : 'WhatsApp'}{x.resend && <> <Badge>resend</Badge></>}</td><td>{x.recipient}</td><td><StatusBadge status={x.status} /></td><td>{x.attempts}</td><td className="small muted">{x.error ?? ''}</td>
            <td className="r">{can('statements:send') && (x.status === 'FAILED' || x.status === 'BOUNCED') && <button className="btn sm" disabled={busy} onClick={() => resend(x.statementId)}>Resend</button>}</td></tr>)}</tbody></table>)}</Card>}</Loaded>
    </Page>
  );
}

export function Integrations() {
  const q = useLoad(() => api.get('/api/settings/email').catch((e) => ({ denied: e.message })), []);
  return (
    <Page title="Integrations" sub="Where revenue comes from and how statements are delivered">
      <div className="grid k2">
        <Card title={<>Airbnb CSV import <Badge tone="good">Active</Badge></>}><p style={{ marginTop: 0 }} className="muted">Upload an earnings export you download from Airbnb. No Airbnb credentials are stored and the app never contacts Airbnb.</p><Link className="btn" to="/import">Open import</Link></Card>
        <Card title={<>Airbnb API / PMS <Badge>Not connected</Badge></>}><p style={{ margin: 0 }} className="muted">Direct connections require approval under Airbnb's API or software-partner programs and are subject to their data terms. The import layer is built so one can be added later without changing statements.</p></Card>
        <Loaded q={q}>{(d: any) => d.denied ? <Card title="Email and WhatsApp"><Note tone="warn">Integration status is visible to managers and administrators. {d.denied}</Note></Card> : (<>
          <Card title={<>WhatsApp {d.whatsapp.configured ? <Badge tone="good">{d.whatsapp.provider === 'meta' ? 'Meta Cloud API' : 'Twilio'}</Badge> : <Badge>Not configured</Badge>}</>}>
            {d.whatsapp.configured ? (<>
              <p style={{ marginTop: 0 }} className="muted">Owners with WhatsApp enabled <b>and opted in</b> get a short message with a secure link when you send a statement. {d.whatsapp.includeSummary ? 'The message includes the owner proceeds amount.' : 'The message contains no dollar amounts.'} An owner who replies STOP is opted out immediately.</p>
              <dl className="dl"><dt>Template</dt><dd style={{ overflowWrap: 'anywhere' }}><code>{d.whatsapp.includeSummary ? d.whatsapp.templates.statement_ready_summary : d.whatsapp.templates.statement_ready}</code></dd>
                <dt>Receipts / STOP</dt><dd>{d.whatsapp.webhooksConfigured ? <Badge tone="good">Webhook configured</Badge> : <Badge tone="bad">Webhook secret missing</Badge>}</dd></dl>
              {d.whatsapp.warnings.map((w: string, i: number) => <Note key={i} tone="warn">{w}</Note>)}
              <Note tone="info">WhatsApp only delivers templates that have been <b>approved</b> in your Meta/Twilio account. A template that is not approved is rejected at send time.</Note>
            </>) : <p style={{ margin: 0 }} className="muted">Set <code>WHATSAPP_PROVIDER</code> (<code>meta</code> or <code>twilio</code>) and its credentials on the server to enable WhatsApp. Owner opt-in rules are already enforced. See <code>docs/whatsapp-setup.md</code>.</p>}
          </Card>
          <Card title={<>Email {d.configured ? <Badge tone="good">{d.provider}</Badge> : <Badge tone="bad">Not configured</Badge>}</>}>
            {d.configured ? <p style={{ marginTop: 0 }} className="muted">Statements are sent through <b>{d.provider}</b>. Credentials are stored in the server environment, never in the database.</p> : <Note tone="warn">Set <code>EMAIL_PROVIDER</code> and its credentials on the server to enable statement emails.</Note>}
            {d.warnings.map((w: string, i: number) => <Note key={i} tone="warn">{w}</Note>)}
            <dl className="dl"><dt>Delivery webhooks</dt><dd>{d.webhooksConfigured ? <Badge tone="good">Configured</Badge> : <><Badge>Not configured</Badge> <span className="muted small">statuses stay at “Sent”</span></>}</dd></dl>
          </Card>
          <Card title={<>File storage <Badge tone={d.storage === 's3' ? 'good' : 'warn'}>{d.storage === 's3' ? 'S3-compatible' : 'Server disk'}</Badge></>}>
            <p style={{ marginTop: 0 }} className="muted">Receipts and the archived PDF/CSV of every finalized statement are stored here. Each file's SHA-256 is recorded and checked on download.</p>
            {d.storage !== 's3' && <Note tone="warn">Files are on this server's disk. Use a persistent volume and back it up, or switch to S3-compatible storage (<code>FILE_STORE=s3</code>).</Note>}
          </Card>
          <Card title="Background jobs"><dl className="dl">{['QUEUED', 'RUNNING', 'DONE', 'FAILED'].map((k) => <><dt key={k + 't'}>{k.charAt(0) + k.slice(1).toLowerCase()}</dt><dd key={k}>{d.jobs[k] ?? 0}</dd></>)}</dl>
            <dl className="dl"><dt>Worker</dt><dd>{d.worker.active > 0 ? <Badge tone="good">Running ({d.worker.active})</Badge> : <Badge tone="bad">Not running</Badge>}{d.worker.lastSeenSecondsAgo !== null && d.worker.active === 0 && <span className="muted small"> last seen {Math.round(d.worker.lastSeenSecondsAgo / 60)} min ago</span>}</dd></dl>
            {d.worker.active === 0 && <Note tone="bad"><b>No background worker is running.</b> Statements will not be emailed and PDFs will not be archived until the worker process (<code>npm run worker</code>, or the <code>worker</code> container) is started.</Note>}</Card></>)}</Loaded>
      </div>
    </Page>
  );
}
