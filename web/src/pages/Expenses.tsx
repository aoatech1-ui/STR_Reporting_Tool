import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, qs } from '../api';
import { useSession } from '../auth';
import { currentYm, fmtDate, fmtDateTime, fmtMonth, parseDollars } from '../format';
import { Badge, Card, ConfirmButton, Empty, Field, Loaded, Modal, Money, MonthPicker, Note, Page, StatusBadge, useAction, useLoad, useToast } from '../ui';

function ExpenseForm({ properties, categories, initial, id, defaultMonth, onSaved, onCancel }: { properties: any[]; categories: any[]; initial?: any; id?: string; defaultMonth: string; onSaved: () => void; onCancel: () => void }) {
  const [v, setV] = useState({
    propertyId: initial?.propertyId ?? properties[0]?.id ?? '', date: initial?.date ?? `${defaultMonth}-${currentYm() === defaultMonth ? new Date().toISOString().slice(8, 10) : '01'}`,
    vendor: initial?.vendor ?? '', category: initial?.category ?? 'Repairs', amount: initial ? (initial.amountCents / 100).toFixed(2) : '', tax: initial && initial.taxCents ? (initial.taxCents / 100).toFixed(2) : '',
    description: initial?.description ?? '', ownerPaid: initial?.ownerPaid ?? false, reimbursable: initial?.reimbursable ?? false, notes: initial?.notes ?? '',
  });
  const [receipt, setReceipt] = useState<File | null>(null);
  const { busy, error, run, setError } = useAction();
  const toast = useToast();
  const set = (k: string, x: unknown) => setV((s) => ({ ...s, [k]: x }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const amountCents = parseDollars(v.amount), taxCents = v.tax ? parseDollars(v.tax) : 0;
    if (amountCents === null || amountCents === 0) return setError('Enter an amount like 125.50 (a credit can be negative)');
    if (taxCents === null) return setError('Tax must be an amount like 8.25');
    const body = { vendor: v.vendor, category: v.category, amountCents, taxCents, description: v.description || undefined, ownerPaid: v.ownerPaid, reimbursable: v.reimbursable, notes: v.notes || undefined };
    if (receipt && receipt.size > 10 * 1024 * 1024) return setError('The receipt is larger than 10 MB');
    const ok = await run(async () => {
      if (id) { await api.patch(`/api/expenses/${id}`, body); return true; }
      const created = await api.post('/api/expenses', { ...body, propertyId: v.propertyId, date: v.date });
      if (receipt) {
        try { await api.upload(`/api/expenses/${created.id}/receipt?filename=${encodeURIComponent(receipt.name)}`, receipt); }
        catch (e) { toast(`Expense saved, but the receipt was not attached: ${(e as Error).message}`, 'warn'); }
      }
      return true;
    });
    if (ok) onSaved();
  };
  return (
    <form onSubmit={submit}>
      {error && <div className="alert bad" role="alert">{error}</div>}
      <div className="form-grid">
        {!id && <Field label="Property"><select value={v.propertyId} onChange={(e) => set('propertyId', e.target.value)} required>{properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>}
        {!id && <Field label="Date"><input type="date" value={v.date} onChange={(e) => set('date', e.target.value)} required /></Field>}
        <Field label="Vendor"><input value={v.vendor} onChange={(e) => set('vendor', e.target.value)} required /></Field>
        <Field label="Category" hint="Pick one or type a new category"><input list="cats" value={v.category} onChange={(e) => set('category', e.target.value)} required /><datalist id="cats">{categories.map((c) => <option key={c.id} value={c.name} />)}</datalist></Field>
        <Field label="Amount ($)"><input inputMode="decimal" value={v.amount} onChange={(e) => set('amount', e.target.value)} placeholder="0.00" required /></Field>
        <Field label="Sales tax ($, optional)"><input inputMode="decimal" value={v.tax} onChange={(e) => set('tax', e.target.value)} placeholder="0.00" /></Field>
        <Field label="Description" wide><input value={v.description} onChange={(e) => set('description', e.target.value)} /></Field>
        <label className="field check"><input type="checkbox" checked={v.ownerPaid} onChange={(e) => set('ownerPaid', e.target.checked)} /><span>Owner paid this directly (shown, not deducted)</span></label>
        <label className="field check"><input type="checkbox" checked={v.reimbursable} onChange={(e) => set('reimbursable', e.target.checked)} /><span>Reimbursable</span></label>
        <Field label="Notes" wide><textarea rows={2} value={v.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
        {!id && <Field label="Receipt (optional)" hint="PDF, PNG, JPEG or WebP, up to 10 MB" wide><input type="file" accept="application/pdf,image/png,image/jpeg,image/webp" onChange={(e) => setReceipt(e.target.files?.[0] ?? null)} /></Field>}
      </div>
      <div className="form-actions"><button type="button" className="btn" onClick={onCancel}>Cancel</button><button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Save expense'}</button></div>
    </form>
  );
}

export function Expenses() {
  const { can } = useSession();
  const nav = useNavigate();
  const toast = useToast();
  const [sp, setSp] = useSearchParams();
  const ym = sp.get('ym') ?? currentYm();
  const propertyId = sp.get('propertyId') ?? '';
  const [adding, setAdding] = useState(false);
  const meta = useLoad(async () => { const [p, c] = await Promise.all([api.get('/api/properties'), api.get('/api/expense-categories')]); return { properties: p.properties as any[], categories: c.categories as any[] }; }, []);
  const q = useLoad(() => api.get(`/api/expenses${qs({ ym, propertyId })}`), [ym, propertyId]);
  const set = (o: Record<string, string>) => setSp({ ym, propertyId, ...o });
  const props: any[] = meta.data?.properties ?? [];
  return (
    <Page title="Expenses" sub={`Property expenses for ${fmtMonth(ym)}`} actions={can('expenses:write') && <button className="btn primary" disabled={!props.length} onClick={() => setAdding(true)}>Add expense</button>}>
      <div className="toolbar">
        <MonthPicker value={ym} onChange={(v) => set({ ym: v })} />
        <label className="inline-field"><span>Property</span><select value={propertyId} onChange={(e) => set({ propertyId: e.target.value })}><option value="">All properties</option>{props.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      </div>
      <Loaded q={q}>{(d) => (
        <Card flush>
          {d.expenses.length === 0 ? <Empty>No expenses recorded for {fmtMonth(ym)}.</Empty> : (
            <table><thead><tr><th>Date</th><th>Property</th><th>Category</th><th>Vendor</th><th>Description</th><th>Receipt</th><th className="r">Amount</th></tr></thead><tbody>
              {d.expenses.map((e: any) => (
                <tr key={e.id} className="click" onClick={() => nav(`/expenses/${e.id}`)}>
                  <td className="nowrap">{fmtDate(e.date)}</td><td>{props.find((p) => p.id === e.propertyId)?.name}</td><td>{e.category}</td><td><Link to={`/expenses/${e.id}`} onClick={(x) => x.stopPropagation()}>{e.vendor}</Link></td>
                  <td>{e.description}{e.ownerPaid && <> <Badge tone="info">Owner-paid</Badge></>}</td><td>{e.receiptCount > 0 ? <Badge tone="good">{e.receiptCount === 1 ? '1 receipt' : `${e.receiptCount} receipts`}</Badge> : (!e.reverses && e.amountCents + e.taxCents >= d.receiptThresholdCents ? <Badge tone="warn">Missing</Badge> : <span className="muted">—</span>)}</td><td className="r"><Money cents={e.amountCents + e.taxCents} /></td></tr>))}</tbody>
              <tfoot><tr><td colSpan={6}>Charged to owners</td><td className="r"><Money cents={d.totals.chargedCents} /></td></tr>
                {d.totals.ownerPaidCents > 0 && <tr><td colSpan={5} className="muted">Paid directly by owners (not deducted)</td><td /><td className="r"><Money cents={d.totals.ownerPaidCents} /></td></tr>}</tfoot></table>)}
        </Card>)}</Loaded>
      {adding && meta.data && <Modal title="Add expense" wide onClose={() => setAdding(false)}><ExpenseForm properties={props} categories={meta.data.categories} defaultMonth={ym} onCancel={() => setAdding(false)} onSaved={() => { setAdding(false); toast('Expense saved'); q.reload(); meta.reload(); }} /></Modal>}
    </Page>
  );
}

export function ExpenseDetail() {
  const { id } = useParams();
  const { can } = useSession();
  const nav = useNavigate();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [reversing, setReversing] = useState(false);
  const [rm, setRm] = useState(''); const [reason, setReason] = useState('');
  const { busy, error, run } = useAction();
  const q = useLoad(async () => {
    const ex = await api.get(`/api/expenses/${id}`);
    const e = ex.expense;
    const [p, c, props, audit] = await Promise.all([api.get('/api/periods'), api.get('/api/expense-categories'), api.get('/api/properties'),
      can('audit:read') ? api.get(`/api/audit?entityType=expense&entityId=${id}`) : Promise.resolve({ entries: [] })]);
    const period = (p.periods as any[]).find((x) => x.id === e.periodId);
    return { e, receipts: (ex.receipts ?? []) as any[], period, categories: c.categories as any[], properties: props.properties as any[], audit: audit.entries as any[] };
  }, [id]);
  return (
    <Page title="Expense" actions={<Link className="btn" to="/expenses">Back to expenses</Link>}>
      <Loaded q={q}>{({ e, receipts, period, categories, properties, audit }) => {
        const open = period && (period.status === 'DRAFT' || period.status === 'REVIEW');
        const ym = period ? `${period.year}-${String(period.month).padStart(2, '0')}` : '';
        return (<>
          <Card title={e.vendor} actions={<><Money cents={e.amountCents + e.taxCents} strong /> {e.ownerPaid && <Badge tone="info">Owner-paid</Badge>}</>}>
            <dl className="dl"><dt>Property</dt><dd>{properties.find((p) => p.id === e.propertyId)?.name}</dd><dt>Date</dt><dd>{fmtDate(e.date)}</dd><dt>Accounting month</dt><dd>{ym ? fmtMonth(ym) : '—'} {period && <StatusBadge status={period.status} />}</dd>
              <dt>Category</dt><dd>{e.category}</dd><dt>Description</dt><dd>{e.description || '—'}</dd><dt>Amount</dt><dd><Money cents={e.amountCents} /> {e.taxCents ? <span className="muted">+ <Money cents={e.taxCents} /> tax</span> : null}</dd>
              {e.reverses && <><dt>Reverses</dt><dd><Link to={`/expenses/${e.reverses}`}>Original expense</Link></dd></>}<dt>Notes</dt><dd>{e.notes || '—'}</dd></dl>
            {can('expenses:write') && <div className="actions" style={{ marginTop: 16 }}>
              {open ? <><button className="btn" onClick={() => setEditing(true)}>Edit</button>
                <ConfirmButton label="Delete" confirm="Delete this expense? This is recorded in the audit log." onConfirm={async () => { if (await run(async () => { await api.del(`/api/expenses/${e.id}`); return true; })) { toast('Expense deleted'); nav('/expenses'); } }} /></>
                : <button className="btn" onClick={() => setReversing(true)}>Reverse in an open month</button>}
            </div>}
            {!open && <Note tone="info">This month is {period?.status.toLowerCase()}. It cannot be edited; post a reversal into an open month to correct it.</Note>}
            {error && <div className="alert bad" role="alert">{error}</div>}
          </Card>
          <Card title={<>Receipts {receipts.length > 0 && <Badge tone="good">{receipts.length}</Badge>}</>}>
            {receipts.length === 0 ? <p className="muted" style={{ marginTop: 0 }}>No receipt attached.</p> : (
              <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                {receipts.map((r: any) => (
                  <li key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    {r.contentType.startsWith('image/') ? <a href={`/api/receipts/${r.id}`}><img src={`/api/receipts/${r.id}/preview`} alt="" width={56} height={56} style={{ objectFit: 'cover', borderRadius: 6, border: '1px solid var(--line)' }} /></a>
                      : <span className="badge info" style={{ width: 56, textAlign: 'center' }}>PDF</span>}
                    <div style={{ flex: 1, minWidth: 0 }}><a href={`/api/receipts/${r.id}`}>{r.filename}</a><div className="muted small">{r.sizeBytes < 1024 ? `${r.sizeBytes} B` : `${Math.round(r.sizeBytes / 1024)} KB`} · added {fmtDateTime(r.createdAt)}</div></div>
                    {can('expenses:write') && open && <ConfirmButton label="Remove" className="btn sm danger" confirm="Remove this receipt? This is recorded in the audit log." onConfirm={async () => { if (await run(async () => { await api.del(`/api/receipts/${r.id}`); return true; })) { toast('Receipt removed'); q.reload(); } }} />}
                  </li>))}
              </ul>)}
            {can('expenses:write') && receipts.length < 10 && <label className="field"><span>Attach a receipt</span>
              <input type="file" accept="application/pdf,image/png,image/jpeg,image/webp" aria-label="Attach a receipt" onChange={async (ev) => {
                const f = ev.target.files?.[0]; ev.target.value = '';
                if (!f) return;
                if (f.size > 10 * 1024 * 1024) return toast('That file is larger than 10 MB', 'bad');
                if (await run(async () => { await api.upload(`/api/expenses/${e.id}/receipt?filename=${encodeURIComponent(f.name)}`, f); return true; })) { toast('Receipt attached'); q.reload(); }
              }} /><small>PDF, PNG, JPEG or WebP, up to 10 MB.{!open && ' You can still document a closed month; receipts cannot be removed afterwards.'}</small></label>}
          </Card>
          {audit.length > 0 && <Card title="History" flush><table><thead><tr><th>When</th><th>Who</th><th>Action</th></tr></thead><tbody>{audit.map((a: any) => <tr key={a.id}><td>{fmtDateTime(a.at)}</td><td>{a.userName ?? '—'}</td><td>{a.action.replace(/_/g, ' ').toLowerCase()}</td></tr>)}</tbody></table></Card>}
          {editing && <Modal title="Edit expense" wide onClose={() => setEditing(false)}><ExpenseForm id={e.id} initial={e} properties={properties} categories={categories} defaultMonth={ym} onCancel={() => setEditing(false)} onSaved={() => { setEditing(false); toast('Expense updated'); q.reload(); }} /></Modal>}
          {reversing && <Modal title="Reverse expense" onClose={() => setReversing(false)}>
            <form onSubmit={async (x) => { x.preventDefault(); const r = await run(() => api.post(`/api/expenses/${e.id}/reverse`, { intoMonth: rm, reason })); if (r) { toast('Reversal posted'); nav(`/expenses/${r.id}`); } }}>
              <Note>Posts a negating entry into the month you choose. The original stays untouched.</Note>
              <div className="form-grid"><Field label="Post into month"><input type="month" value={rm} onChange={(x) => setRm(x.target.value)} required /></Field><Field label="Reason" wide><input value={reason} onChange={(x) => setReason(x.target.value)} minLength={3} required /></Field></div>
              {error && <div className="alert bad" role="alert">{error}</div>}
              <div className="form-actions"><button type="button" className="btn" onClick={() => setReversing(false)}>Cancel</button><button className="btn primary" disabled={busy}>Post reversal</button></div>
            </form></Modal>}
        </>);
      }}</Loaded>
    </Page>
  );
}
