import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useSession } from '../auth';
import { fmtDate, fmtDateTime, fmtMonth, parseDollars } from '../format';
import { Badge, Card, ConfirmButton, Empty, Field, Loaded, Modal, Money, Note, Page, useAction, useLoad, useToast } from '../ui';

const FREQ: [number, string][] = [[1, 'Monthly'], [2, 'Every 2 months'], [3, 'Quarterly'], [6, 'Twice a year'], [12, 'Yearly']];
const ord = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
const thisMonth = () => new Date().toISOString().slice(0, 7);

function RecurringForm({ properties, categories, initial, id, onSaved, onCancel }: { properties: any[]; categories: any[]; initial?: any; id?: string; onSaved: (r: any) => void; onCancel: () => void }) {
  const [v, setV] = useState({
    propertyId: initial?.propertyId ?? properties[0]?.id ?? '', vendor: initial?.vendor ?? '', category: initial?.category ?? 'Utilities',
    amount: initial ? (initial.amountCents / 100).toFixed(2) : '', tax: initial?.taxCents ? (initial.taxCents / 100).toFixed(2) : '',
    description: initial?.description ?? '', ownerPaid: initial?.ownerPaid ?? false, reimbursable: initial?.reimbursable ?? false, notes: initial?.notes ?? '',
    intervalMonths: initial?.intervalMonths ?? 1, dayOfMonth: initial?.dayOfMonth ?? 1, startMonth: initial?.startMonth ?? thisMonth(), endMonth: initial?.endMonth ?? '',
  });
  const { busy, error, run, setError } = useAction();
  const set = (k: string, x: unknown) => setV((s) => ({ ...s, [k]: x }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const amountCents = parseDollars(v.amount), taxCents = v.tax ? parseDollars(v.tax) : 0;
    if (amountCents === null || amountCents === 0) return setError('Enter an amount like 89.99');
    if (taxCents === null) return setError('Tax must be an amount like 8.25');
    const body: any = { vendor: v.vendor, category: v.category, amountCents, taxCents, description: v.description || null, ownerPaid: v.ownerPaid, reimbursable: v.reimbursable, notes: v.notes || null,
      intervalMonths: Number(v.intervalMonths), dayOfMonth: Number(v.dayOfMonth), startMonth: v.startMonth, endMonth: v.endMonth || null };
    const r = await run(() => (id ? api.patch(`/api/recurring-expenses/${id}`, body) : api.post('/api/recurring-expenses', { ...body, propertyId: v.propertyId })));
    if (r) onSaved(r);
  };
  const past = !id && v.startMonth < thisMonth();
  return (<form onSubmit={submit}>
    {error && <div className="alert bad" role="alert">{error}</div>}
    <div className="form-grid">
      {!id && <Field label="Property"><select value={v.propertyId} onChange={(e) => set('propertyId', e.target.value)} required>{properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>}
      <Field label="Vendor"><input value={v.vendor} onChange={(e) => set('vendor', e.target.value)} required /></Field>
      <Field label="Category" hint="Pick one or type a new category"><input list="rcats" value={v.category} onChange={(e) => set('category', e.target.value)} required /><datalist id="rcats">{categories.map((c) => <option key={c.id} value={c.name} />)}</datalist></Field>
      <Field label="Amount ($)"><input inputMode="decimal" value={v.amount} onChange={(e) => set('amount', e.target.value)} placeholder="0.00" required /></Field>
      <Field label="Sales tax ($, optional)"><input inputMode="decimal" value={v.tax} onChange={(e) => set('tax', e.target.value)} placeholder="0.00" /></Field>
      <Field label="Repeats"><select value={v.intervalMonths} onChange={(e) => set('intervalMonths', e.target.value)}>{FREQ.map(([n, l]) => <option key={n} value={n}>{l}</option>)}</select></Field>
      <Field label="On day" hint="Days past the month's end use its last day"><select value={v.dayOfMonth} onChange={(e) => set('dayOfMonth', e.target.value)}>{Array.from({ length: 31 }, (_, i) => <option key={i + 1} value={i + 1}>{i === 30 ? 'Last day of the month' : ord(i + 1)}</option>)}</select></Field>
      <Field label="First month"><input type="month" value={v.startMonth} onChange={(e) => set('startMonth', e.target.value)} required /></Field>
      <Field label="Last month (optional)"><input type="month" value={v.endMonth} onChange={(e) => set('endMonth', e.target.value)} /></Field>
      <Field label="Description" wide><input value={v.description} onChange={(e) => set('description', e.target.value)} /></Field>
      <label className="field check"><input type="checkbox" checked={v.ownerPaid} onChange={(e) => set('ownerPaid', e.target.checked)} /><span>Owner pays this directly (shown, not deducted)</span></label>
      <label className="field check"><input type="checkbox" checked={v.reimbursable} onChange={(e) => set('reimbursable', e.target.checked)} /><span>Reimbursable</span></label>
      <Field label="Notes" wide><textarea rows={2} value={v.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
    </div>
    {past && <Note tone="warn">The first month is in the past: occurrences already due in open months are posted as soon as you save. Months that are finalized are skipped.</Note>}
    {id && <Note>Changes apply to months not yet posted. Expenses already posted stay as they are; edit them individually if needed.</Note>}
    <div className="form-actions"><button type="button" className="btn" onClick={onCancel}>Cancel</button><button className="btn primary" disabled={busy}>{busy ? 'Saving…' : id ? 'Save changes' : 'Create'}</button></div>
  </form>);
}

const meta = async () => { const [p, c] = await Promise.all([api.get('/api/properties'), api.get('/api/expense-categories')]); return { properties: p.properties as any[], categories: c.categories as any[] }; };
const postedMsg = (r: any) => (r.posted ? `${r.posted} expense${r.posted === 1 ? '' : 's'} posted` : '') + (r.skipped ? `${r.posted ? ', ' : ''}${r.skipped} skipped (month finalized)` : '');

export function RecurringList() {
  const { can } = useSession();
  const nav = useNavigate();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const m = useLoad(meta, []);
  const q = useLoad(() => api.get('/api/recurring-expenses'), []);
  const { error, run } = useAction();
  const runNow = async () => { const r = await run(() => api.post('/api/recurring-expenses/run')); if (r) { toast(postedMsg(r) || 'Nothing due right now'); q.reload(); } };
  return (<Page title="Recurring expenses" sub="Expenses that repeat (utilities, insurance, HOA, subscriptions) are posted automatically on their day, into that month"
    actions={can('expenses:write') && <><button className="btn" onClick={runNow}>Post due now</button><button className="btn primary" disabled={!m.data?.properties.length} onClick={() => setAdding(true)}>Add recurring expense</button></>}>
    {error && <div className="alert bad" role="alert">{error}</div>}
    <Loaded q={q}>{(d) => (<>
      <Card flush>{d.recurring.length === 0 ? <Empty>No recurring expenses yet. Add the ones that repeat every month or quarter and they will be posted for you.</Empty> : (
        <table><thead><tr><th>Property</th><th>Vendor</th><th>Category</th><th>Schedule</th><th>Next</th><th>Last posted</th><th className="r">Amount</th></tr></thead><tbody>
          {d.recurring.map((r: any) => <tr key={r.id} className="click" onClick={() => nav(`/recurring/${r.id}`)}>
            <td>{r.propertyName}</td><td><Link to={`/recurring/${r.id}`} onClick={(x) => x.stopPropagation()}>{r.vendor}</Link>{!r.active && <> <Badge>Stopped</Badge></>}{r.ownerPaid && <> <Badge tone="info">Owner-paid</Badge></>}</td>
            <td>{r.category}</td><td>{r.schedule}</td><td className="nowrap">{r.next ? fmtDate(r.next) : <span className="muted">—</span>}</td>
            <td>{r.last ? <>{r.last.month} {r.last.status === 'SKIPPED' ? <Badge>Skipped</Badge> : r.last.expenseId ? null : <Badge>Deleted</Badge>}</> : <span className="muted">—</span>}</td>
            <td className="r"><Money cents={r.amountCents + r.taxCents} /></td></tr>)}</tbody>
          <tfoot><tr><td colSpan={6}>Monthly equivalent of active, manager-paid recurring expenses</td><td className="r"><Money cents={d.monthlyEquivalentCents} /></td></tr></tfoot></table>)}</Card>
      <p className="muted small">Each occurrence becomes an ordinary expense in its month: it can be edited, given a receipt, or deleted (which drops that month only). When a month is reviewed or finalized, its recurring expenses are posted even if their day has not come yet.</p>
    </>)}</Loaded>
    {adding && m.data && <Modal title="Add recurring expense" wide onClose={() => setAdding(false)}><RecurringForm properties={m.data.properties} categories={m.data.categories} onCancel={() => setAdding(false)}
      onSaved={(r) => { setAdding(false); toast(['Recurring expense created', postedMsg(r)].filter(Boolean).join('. ')); nav(`/recurring/${r.id}`); }} /></Modal>}
  </Page>);
}

export function RecurringDetail() {
  const { id } = useParams();
  const { can } = useSession();
  const nav = useNavigate();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const m = useLoad(meta, []);
  const q = useLoad(() => api.get(`/api/recurring-expenses/${id}`), [id]);
  const { error, run } = useAction();
  const act = async (fn: () => Promise<any>, msg: (r: any) => string) => { const r = await run(fn); if (r) { toast(msg(r)); q.reload(); } };
  const w = can('expenses:write');
  return (<Page title="Recurring expense" actions={<Link className="btn" to="/recurring">All recurring expenses</Link>}>
    {error && <div className="alert bad" role="alert">{error}</div>}
    <Loaded q={q}>{({ recurring: r, postings, upcoming }) => (<>
      <Card title={<>{r.vendor} {r.active ? <Badge tone="good">Active</Badge> : <Badge>Stopped</Badge>}</>} actions={<Money cents={r.amountCents + r.taxCents} strong />}>
        <dl className="dl"><dt>Property</dt><dd>{r.propertyName}</dd><dt>Schedule</dt><dd>{r.schedule}</dd><dt>From</dt><dd>{fmtMonth(r.startMonth)}{r.endMonth ? ` to ${fmtMonth(r.endMonth)}` : ', no end date'}</dd>
          <dt>Category</dt><dd>{r.category}</dd><dt>Amount</dt><dd><Money cents={r.amountCents} /> {r.taxCents ? <span className="muted">+ <Money cents={r.taxCents} /> tax</span> : null}{r.ownerPaid && <> <Badge tone="info">Owner-paid</Badge></>}</dd>
          <dt>Description</dt><dd>{r.description || '—'}</dd><dt>Notes</dt><dd>{r.notes || '—'}</dd></dl>
        {w && <div className="actions" style={{ marginTop: 16 }}>
          <button className="btn" onClick={() => setEditing(true)}>Edit</button>
          {r.active ? <ConfirmButton className="btn" label="Stop" confirm="Stop this recurring expense? Nothing more will be posted. Expenses already posted stay." onConfirm={() => act(() => api.patch(`/api/recurring-expenses/${id}`, { active: false }), () => 'Stopped')} />
            : <button className="btn" onClick={() => act(() => api.patch(`/api/recurring-expenses/${id}`, { active: true }), (x) => ['Resumed', postedMsg(x)].filter(Boolean).join('. '))}>Resume</button>}
          {postings.length === 0 && <ConfirmButton label="Delete" confirm="Delete this recurring expense?" onConfirm={async () => { if (await run(() => api.del(`/api/recurring-expenses/${id}`))) { toast('Deleted'); nav('/recurring'); } }} />}
        </div>}
      </Card>
      <Card title="Upcoming" flush>{upcoming.length === 0 ? <Empty>{r.active ? 'Nothing scheduled.' : 'Stopped: nothing will be posted.'}</Empty> : (
        <table><thead><tr><th>Date</th><th>Month</th><th /></tr></thead><tbody>{upcoming.map((u: any) => <tr key={u.date}><td>{fmtDate(u.date)}</td><td>{u.monthLabel} {u.skipped && <Badge>Skipped</Badge>}</td>
          <td className="r">{w && (u.skipped ? <button className="btn sm" onClick={() => act(() => api.post(`/api/recurring-expenses/${id}/unskip`, { month: u.ym }), () => `${u.monthLabel} will be posted`)}>Undo skip</button>
            : <button className="btn sm" onClick={() => act(() => api.post(`/api/recurring-expenses/${id}/skip`, { month: u.ym }), () => `${u.monthLabel} skipped`)}>Skip {u.monthLabel.split(' ')[0]}</button>)}</td></tr>)}</tbody></table>)}</Card>
      <Card title="Posted" flush>{postings.length === 0 ? <Empty>Nothing posted yet.</Empty> : (
        <table><thead><tr><th>Month</th><th>Result</th><th>By</th><th>When</th><th className="r">Amount</th></tr></thead><tbody>{postings.map((p: any) => <tr key={p.id}>
          <td>{p.monthLabel}</td>
          <td>{p.status === 'SKIPPED' ? <><Badge>Skipped</Badge> <span className="muted small">{p.reason}</span>{w && <> <button className="btn sm" onClick={() => act(() => api.post(`/api/recurring-expenses/${id}/unskip`, { month: p.ym }), (x) => postedMsg(x) || 'Undone')}>Undo</button></>}</>
            : p.expenseId ? <Link to={`/expenses/${p.expenseId}`}>View expense</Link> : <><Badge>Deleted</Badge> <span className="muted small">The posted expense was deleted; this month is not posted again.</span></>}</td>
          <td>{p.postedBy ?? 'Automatic'}</td><td className="nowrap">{fmtDateTime(p.createdAt)}</td><td className="r">{p.amountCents === null ? <span className="muted">—</span> : <Money cents={p.amountCents} />}</td></tr>)}</tbody></table>)}</Card>
      {editing && m.data && <Modal title="Edit recurring expense" wide onClose={() => setEditing(false)}><RecurringForm id={r.id} initial={r} properties={m.data.properties} categories={m.data.categories} onCancel={() => setEditing(false)}
        onSaved={(x) => { setEditing(false); toast(['Saved', postedMsg(x)].filter(Boolean).join('. ')); q.reload(); }} /></Modal>}
    </>)}</Loaded>
  </Page>);
}
