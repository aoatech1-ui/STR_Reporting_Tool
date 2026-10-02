import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, qs } from '../api';
import { useSession } from '../auth';
import { fmtDate, fmtDateTime, fmtMonth, ymOf } from '../format';
import { StatementDoc } from '../StatementDoc';
import { Badge, Card, Empty, Loaded, Money, Note, Page, StatusBadge, useAction, useLoad, useToast } from '../ui';

export function StatementPreview() {
  const { id } = useParams();
  const { can } = useSession();
  const toast = useToast();
  const { busy, error, run } = useAction();
  const q = useLoad(() => api.get(`/api/statements/${id}`), [id]);
  const send = async (resend: boolean) => {
    const r = await run(() => api.post(`/api/statements/${id}/send`, { resend }));
    if (r) { toast(r.deliveryIds.length ? 'Queued for delivery' : 'Nothing new to send: already queued or sent', r.deliveryIds.length ? 'good' : 'warn'); q.reload(); }
  };
  return (
    <Page title="Statement preview" actions={<Link className="btn" to="/statements">All statements</Link>}>
      <Loaded q={q}>{(d) => {
        const st = d.statement, final = st.status === 'FINALIZED' || st.status === 'LOCKED';
        const sent = d.deliveries.some((x: any) => ['SENT', 'DELIVERED'].includes(x.status));
        const addr = [d.property?.address, d.property?.city, d.property?.state, d.property?.zip].filter(Boolean).join(', ');
        return (<>
          <div className="toolbar no-print">
            <StatusBadge status={st.status} />
            <a className="btn primary" href={`/api/statements/${st.id}/pdf`}>Download PDF</a>
            <a className="btn" href={`/api/statements/${st.id}/csv`}>Download CSV</a>
            <button className="btn" onClick={() => window.print()}>Print</button>
            {can('statements:send') && final && <button className="btn" disabled={busy} onClick={() => send(sent)}>{sent ? 'Resend to owner' : 'Send to owner'}</button>}
            {!final && <span className="muted small">Finalize the month to send this statement.</span>}
            {final && <span className="muted small">{d.files.pdfArchived ? `PDF archived (SHA-256 ${d.files.pdfSha256.slice(0, 12)}…)` : 'PDF is being archived'}</span>}
          </div>
          {error && <div className="alert bad no-print" role="alert">{error}</div>}
          {!final && <Note tone="warn">This is a draft preview. Figures may change until the month is finalized.</Note>}
          <StatementDoc orgName={d.organization.displayName} statementNumber={st.statementNumber} generatedAt={st.generatedAt} ownerName={d.owner.displayName} propertyName={d.property.name} propertyAddress={addr}
            statement={st.detail} ytd={d.ytd} disclaimer={d.disclaimer} draft={!final} />
          <div className="no-print"><Card title="Delivery" flush>
            {d.deliveries.length === 0 ? <Empty>Not sent yet.</Empty> : <table><thead><tr><th>Channel</th><th>Recipient</th><th>Status</th><th>Sent</th><th>Detail</th></tr></thead><tbody>
              {d.deliveries.map((x: any) => <tr key={x.id}><td>{x.channel === 'EMAIL' ? 'Email' : 'WhatsApp'}{x.resend && <> <Badge>resend</Badge></>}</td><td>{x.recipient}</td><td><StatusBadge status={x.status} /></td><td>{fmtDateTime(x.sentAt)}</td><td className="muted small">{x.error ?? ''}</td></tr>)}</tbody></table>}
          </Card></div>
        </>);
      }}</Loaded>
    </Page>
  );
}

export function StatementHistory() {
  const [sp, setSp] = useSearchParams();
  const status = sp.get('status') ?? '', ownerId = sp.get('ownerId') ?? '', ym = sp.get('ym') ?? '';
  const owners = useLoad(() => api.get('/api/owners'), []);
  const q = useLoad(() => api.get(`/api/statements${qs({ status, ownerId, ym })}`), [status, ownerId, ym]);
  const set = (o: Record<string, string>) => setSp({ status, ownerId, ym, ...o });
  return (
    <Page title="Statements" sub="Every owner statement, newest first">
      <div className="toolbar">
        <label className="inline-field"><span>Month</span><input type="month" value={ym} onChange={(e) => set({ ym: e.target.value })} /></label>
        <label className="inline-field"><span>Status</span><select value={status} onChange={(e) => set({ status: e.target.value })}><option value="">All</option>{['DRAFT', 'REVIEW', 'FINALIZED', 'LOCKED'].map((s) => <option key={s} value={s}>{s.charAt(0) + s.slice(1).toLowerCase()}</option>)}</select></label>
        <label className="inline-field"><span>Owner</span><select value={ownerId} onChange={(e) => set({ ownerId: e.target.value })}><option value="">All owners</option>{(owners.data?.owners ?? []).map((o: any) => <option key={o.id} value={o.id}>{o.displayName}</option>)}</select></label>
        {(status || ownerId || ym) && <button className="btn sm ghost" onClick={() => setSp({})}>Clear filters</button>}
      </div>
      <Loaded q={q}>{(d) => <Card flush>{d.statements.length === 0 ? <Empty>No statements match.</Empty> : (
        <table><thead><tr><th>Statement</th><th>Month</th><th>Owner</th><th>Property</th><th className="r">Owner proceeds</th><th>Status</th><th>Finalized</th></tr></thead><tbody>
          {[...d.statements].reverse().map((s: any) => <tr key={s.id}><td><Link to={`/statements/${s.id}`}>{s.statementNumber}</Link></td><td>{fmtMonth(ymOf(s.year, s.month))}</td><td>{s.ownerName}</td><td>{s.propertyName}</td><td className="r"><Money cents={s.ownerProceedsCents} strong /></td><td><StatusBadge status={s.status} /></td><td>{fmtDate(s.finalizedAt)}</td></tr>)}</tbody></table>)}</Card>}</Loaded>
    </Page>
  );
}
