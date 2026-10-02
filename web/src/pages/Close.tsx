import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useSession } from '../auth';
import { currentYm, fmtMonth } from '../format';
import { Badge, Card, Empty, Loaded, Modal, Money, MonthPicker, Note, Page, StatusBadge, useAction, useLoad, useToast } from '../ui';

export function Close() {
  const { can } = useSession();
  const toast = useToast();
  const [sp, setSp] = useSearchParams();
  const ym = sp.get('ym') ?? currentYm();
  const [exceptions, setExceptions] = useState<any[] | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [ack, setAck] = useState(false);
  const [sendLog, setSendLog] = useState<string[] | null>(null);
  const { busy, error, run, setError } = useAction();
  const q = useLoad(() => api.get(`/api/periods/${ym}`), [ym]);
  const changeMonth = (v: string) => { setSp({ ym: v }); setExceptions(null); setSendLog(null); setError(null); };

  const generate = async () => { const r = await run(() => api.post(`/api/periods/${ym}/generate`)); if (r) { setExceptions(r.exceptions); toast('Review generated'); q.reload(); } };
  const finalize = async (critical: number) => {
    const r = await run(() => api.post(`/api/periods/${ym}/finalize`, { acknowledgeCritical: critical > 0 && ack }));
    if (r) { setConfirming(false); setAck(false); setExceptions(r.exceptions); toast(`${fmtMonth(ym)} finalized and locked`); q.reload(); }
  };
  const sendAll = async (ids: string[]) => {
    const log: string[] = [];
    for (const id of ids) {
      try { const r = await api.post(`/api/statements/${id}/send`, {}); log.push(r.deliveryIds.length ? `Queued ${r.queued.map((x: any) => x.channel.toLowerCase()).join(' + ')} for ${id.slice(0, 8)}` : `Nothing to send for ${id.slice(0, 8)} (already queued or sent, or no contact enabled)`); }
      catch (e) { log.push(`${id.slice(0, 8)}: ${(e as Error).message}`); }
    }
    setSendLog(log); q.reload();
  };

  return (
    <Page title={`Close ${fmtMonth(ym)}`} sub="Review every property, resolve exceptions, then finalize to lock the month" actions={<MonthPicker value={ym} onChange={changeMonth} />}>
      <Loaded q={q}>{(d) => {
        const status = d.period?.status ?? 'DRAFT';
        const closed = status === 'FINALIZED' || status === 'LOCKED';
        const critical = (exceptions ?? []).filter((e) => e.severity === 'CRITICAL');
        const negative = d.statements.some((s: any) => s.ownerProceedsCents < 0);
        return (<>
          <div className="toolbar"><span>Status:</span> <StatusBadge status={status} /> {closed && <span className="muted small">Figures are locked. Corrections are made with adjustments in an open month.</span>}</div>
          {error && <div className="alert bad" role="alert">{error}</div>}

          {!closed && <Card title="Checklist">
            <ol style={{ margin: 0, paddingLeft: 20, lineHeight: 1.9 }}>
              <li><Link to="/import">Import Airbnb earnings</Link> and resolve unmatched listings</li>
              <li><Link to={`/expenses?ym=${ym}`}>Enter and review expenses</Link> for {fmtMonth(ym)}</li>
              <li>Generate the review below: calculates commission and owner proceeds for every property</li>
              <li>Resolve exceptions, then finalize</li>
            </ol>
            {can('period:review') && <div className="actions" style={{ marginTop: 14 }}><button className="btn primary" onClick={generate} disabled={busy}>{busy ? 'Working…' : d.statements.length ? 'Refresh review' : 'Generate review'}</button></div>}
          </Card>}

          {exceptions && exceptions.length > 0 && <Card title={<>Exceptions <Badge tone={critical.length ? 'bad' : 'warn'}>{exceptions.length}</Badge></>} flush>
            {exceptions.map((e, i) => <div className="exc" key={i}><StatusBadge status={e.severity} /><span>{e.message}</span></div>)}</Card>}
          {exceptions && exceptions.length === 0 && !closed && <Note tone="good">No exceptions found. This month is ready to finalize.</Note>}

          <Card title="Properties" flush>
            {d.statements.length === 0 ? <Empty>No statements for this month yet. {can('period:review') ? 'Generate the review to calculate them.' : ''}</Empty> : (
              <table><thead><tr><th>Property</th><th>Owner</th><th className="r">Airbnb net payout</th><th className="r">Expenses</th><th className="r">Commission</th><th className="r">Owner proceeds</th><th>Status</th><th /></tr></thead><tbody>
                {d.statements.map((s: any) => <tr key={s.id}>
                  <td><Link to={`/statements/${s.id}`}><b>{s.propertyName}</b></Link></td><td>{s.ownerName}</td>
                  <td className="r"><Money cents={s.netPayoutCents} /></td><td className="r"><Money cents={s.expensesCents} /></td><td className="r"><Money cents={s.commissionCents} /></td>
                  <td className="r"><Money cents={s.ownerProceedsCents} strong /></td><td><StatusBadge status={s.status} />{s.ownerProceedsCents < 0 && <> <Badge tone="bad">Negative</Badge></>}</td>
                  <td className="r"><Link className="btn sm" to={`/statements/${s.id}`}>{closed ? 'View' : 'Review'}</Link></td></tr>)}</tbody>
                <tfoot><tr><td colSpan={2}>Total</td><td className="r"><Money cents={d.totals.netPayoutCents} /></td><td className="r"><Money cents={d.totals.expensesCents} /></td><td className="r"><Money cents={d.totals.commissionCents} /></td><td className="r"><Money cents={d.totals.ownerProceedsCents} strong /></td><td colSpan={2} /></tr></tfoot></table>)}
          </Card>
          {negative && !closed && <Note tone="warn">At least one property has negative owner proceeds. Review it before finalizing.</Note>}

          {!closed && can('period:finalize') && d.statements.length > 0 && (
            <div className="actions"><button className="btn primary" disabled={exceptions === null || busy} onClick={() => { setAck(false); setConfirming(true); }}>Finalize {fmtMonth(ym)}</button>{exceptions === null && <span className="muted small">Generate the review first.</span>}</div>)}

          {closed && can('statements:send') && <Card title="Send statements to owners">
            <p className="muted" style={{ marginTop: 0 }}>Statements are emailed to owners with email enabled (and WhatsApp where they have opted in). Already-sent statements are not sent twice.</p>
            <button className="btn primary" onClick={() => sendAll(d.statements.map((s: any) => s.id))}>Send all statements</button>
            {sendLog && <ul className="small" style={{ marginBottom: 0 }}>{sendLog.map((l, i) => <li key={i}>{l}</li>)}</ul>}
            <p className="muted small" style={{ marginBottom: 0 }}>Track progress under <Link to="/communications">Communications</Link>.</p>
          </Card>}

          {confirming && <Modal title={`Finalize ${fmtMonth(ym)}?`} onClose={() => setConfirming(false)}>
            <p style={{ marginTop: 0 }}>This <b>locks the month</b>: expenses and revenue for {fmtMonth(ym)} can no longer be edited, and statements become final. Corrections afterwards are made as adjustments.</p>
            <dl className="dl"><dt>Properties</dt><dd>{d.statements.length}</dd><dt>Owner proceeds</dt><dd><Money cents={d.totals.ownerProceedsCents} strong /></dd><dt>Commissions</dt><dd><Money cents={d.totals.commissionCents} /></dd></dl>
            {critical.length > 0 && <><Note tone="bad"><b>{critical.length} critical issue(s)</b> remain: {critical.map((c) => c.message).join('; ')}.</Note>
              <label className="field check"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /><span>I have reviewed these issues and want to finalize anyway.</span></label></>}
            {error && <div className="alert bad" role="alert">{error}</div>}
            <div className="form-actions"><button className="btn" onClick={() => setConfirming(false)}>Cancel</button><button className="btn primary" disabled={busy || (critical.length > 0 && !ack)} onClick={() => finalize(critical.length)}>{busy ? 'Finalizing…' : 'Finalize and lock'}</button></div>
          </Modal>}
        </>);
      }}</Loaded>
    </Page>
  );
}
