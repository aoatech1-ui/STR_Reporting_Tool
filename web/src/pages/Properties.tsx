import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, qs } from '../api';
import { useSession } from '../auth';
import { COMMISSION_LABEL, currentYm, fmtDate, fmtMonth, fmtRate, parseDollars } from '../format';
import { Badge, Card, Empty, Field, Loaded, Modal, Money, MonthPicker, Note, Page, StatusBadge, useAction, useLoad, useToast } from '../ui';

const today = () => new Date().toISOString().slice(0, 10);

function describeRule(r: any) {
  const pct = r.type === 'FIXED' ? '' : fmtRate(r.rateBps);
  const fixed = r.fixedCents ? `$${(r.fixedCents / 100).toFixed(2)}` : '';
  if (r.type === 'FIXED') return `${fixed} per month`;
  if (r.type === 'HYBRID') return `${pct} of ${r.hybridBasis === 'GROSS' ? 'gross' : 'net'} + ${fixed}`;
  return `${pct} of ${r.type === 'PERCENT_GROSS' ? 'gross booking revenue' : 'Airbnb net payout'}`;
}

export function CommissionForm({ propertyId, current, onSaved, onCancel }: { propertyId: string; current?: any; onSaved: () => void; onCancel: () => void }) {
  const [type, setType] = useState(current?.type ?? 'PERCENT_NET');
  const [rate, setRate] = useState(current ? String(current.rateBps / 100) : '20');
  const [fixed, setFixed] = useState(current ? (current.fixedCents / 100).toFixed(2) : '');
  const [basis, setBasis] = useState(current?.hybridBasis ?? 'NET');
  const [cleaning, setCleaning] = useState(current?.includeCleaningFees ?? true);
  const [taxes, setTaxes] = useState(current?.excludeTaxes ?? false);
  const [from, setFrom] = useState(today());
  const { busy, error, run, setError } = useAction();
  const usesRate = type !== 'FIXED', usesFixed = type === 'FIXED' || type === 'HYBRID';
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const rateBps = usesRate ? Math.round(parseFloat(rate) * 100) : 0;
    const fixedCents = usesFixed ? parseDollars(fixed) : 0;
    if (usesRate && (!Number.isFinite(rateBps) || rateBps <= 0 || rateBps > 10000)) return setError('Enter a rate between 0.01% and 100%');
    if (usesFixed && (fixedCents === null || fixedCents <= 0)) return setError('Enter a fixed amount greater than $0');
    const ok = await run(async () => { await api.post(`/api/properties/${propertyId}/commission-rules`, { type, rateBps, fixedCents: fixedCents ?? 0, hybridBasis: basis, includeCleaningFees: cleaning, excludeTaxes: taxes, effectiveFrom: from }); return true; });
    if (ok) onSaved();
  };
  return (
    <form onSubmit={submit}>
      {error && <div className="alert bad" role="alert">{error}</div>}
      <Note>The new rate applies from the date below. Months before it keep their existing rate and finalized statements never change.</Note>
      <div className="form-grid">
        <Field label="Commission type" wide><select value={type} onChange={(e) => setType(e.target.value)}>{Object.entries(COMMISSION_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        {usesRate && <Field label="Rate (%)"><input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} required /></Field>}
        {usesFixed && <Field label="Fixed amount ($ per month)"><input inputMode="decimal" value={fixed} onChange={(e) => setFixed(e.target.value)} required /></Field>}
        {type === 'HYBRID' && <Field label="Percentage applies to"><select value={basis} onChange={(e) => setBasis(e.target.value)}><option value="NET">Airbnb net payout</option><option value="GROSS">Gross booking revenue</option></select></Field>}
        <Field label="Effective from"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} required /></Field>
        <label className="field check wide"><input type="checkbox" checked={cleaning} onChange={(e) => setCleaning(e.target.checked)} /><span>Commission applies to cleaning fees</span></label>
        <label className="field check wide"><input type="checkbox" checked={taxes} onChange={(e) => setTaxes(e.target.checked)} /><span>Exclude occupancy taxes from the commission base</span></label>
      </div>
      <div className="form-actions"><button type="button" className="btn" onClick={onCancel}>Cancel</button><button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Save commission'}</button></div>
    </form>
  );
}

function PropertyForm({ owners, initial, id, onSaved, onCancel }: { owners: any[]; initial?: any; id?: string; onSaved: (id: string) => void; onCancel: () => void }) {
  const [v, setV] = useState({ name: '', ownerId: owners[0]?.id ?? '', address: '', city: '', state: '', zip: '', airbnbListingId: '', airbnbListingName: '', managementStartDate: '', managementEndDate: '', notes: '', active: true, ...Object.fromEntries(Object.entries(initial ?? {}).map(([k, x]) => [k, x ?? ''])) });
  const [rate, setRate] = useState('20');
  const [withRule, setWithRule] = useState(!id);
  const { busy, error, run } = useAction();
  const set = (k: string, x: unknown) => setV((s: any) => ({ ...s, [k]: x }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body: any = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x === '' ? null : x]));
    for (const k of ['address', 'city', 'state', 'zip']) if (body[k] === null) delete body[k];
    if (!id) delete body.active; // only editable on existing properties
    const out = await run(async () => {
      if (id) { delete body.ownerId; delete body.id; await api.patch(`/api/properties/${id}`, body); return id; }
      const r = await api.post('/api/properties', body);
      if (withRule) await api.post(`/api/properties/${r.id}/commission-rules`, { type: 'PERCENT_NET', rateBps: Math.round(parseFloat(rate) * 100), effectiveFrom: body.managementStartDate ?? `${new Date().getUTCFullYear()}-01-01` });
      return r.id as string;
    });
    if (out) onSaved(out);
  };
  return (
    <form onSubmit={submit}>
      {error && <div className="alert bad" role="alert">{error}</div>}
      <div className="form-grid">
        <Field label="Property name"><input value={v.name} onChange={(e) => set('name', e.target.value)} required /></Field>
        {!id && <Field label="Owner"><select value={v.ownerId} onChange={(e) => set('ownerId', e.target.value)} required>{owners.map((o) => <option key={o.id} value={o.id}>{o.displayName}</option>)}</select></Field>}
        <Field label="Street address" wide><input value={v.address} onChange={(e) => set('address', e.target.value)} /></Field>
        <Field label="City"><input value={v.city} onChange={(e) => set('city', e.target.value)} /></Field>
        <div className="form-grid"><Field label="State"><input value={v.state} onChange={(e) => set('state', e.target.value)} /></Field><Field label="ZIP"><input value={v.zip} onChange={(e) => set('zip', e.target.value)} /></Field></div>
        <Field label="Airbnb listing name" hint="Must match the Listing column in the Airbnb export"><input value={v.airbnbListingName} onChange={(e) => set('airbnbListingName', e.target.value)} /></Field>
        <Field label="Airbnb listing ID (optional)"><input value={v.airbnbListingId} onChange={(e) => set('airbnbListingId', e.target.value)} /></Field>
        <Field label="Management start"><input type="date" value={v.managementStartDate} onChange={(e) => set('managementStartDate', e.target.value)} /></Field>
        <Field label="Management end"><input type="date" value={v.managementEndDate} onChange={(e) => set('managementEndDate', e.target.value)} /></Field>
        {id && <label className="field check"><input type="checkbox" checked={v.active} onChange={(e) => set('active', e.target.checked)} /><span>Active</span></label>}
        {!id && <>
          <label className="field check wide"><input type="checkbox" checked={withRule} onChange={(e) => setWithRule(e.target.checked)} /><span>Set commission now (percent of Airbnb net payout)</span></label>
          {withRule && <Field label="Commission rate (%)" hint="Change type, cleaning-fee and tax rules later under Commission settings"><input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} /></Field>}
        </>}
        <Field label="Notes" wide><textarea rows={2} value={v.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
      </div>
      <div className="form-actions"><button type="button" className="btn" onClick={onCancel}>Cancel</button><button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Save property'}</button></div>
    </form>
  );
}

const loadAll = async () => {
  const [p, o] = await Promise.all([api.get('/api/properties'), api.get('/api/owners')]);
  const details = await Promise.all((p.properties as any[]).map((x) => api.get(`/api/properties/${x.id}`)));
  return { properties: p.properties as any[], owners: o.owners as any[], rules: Object.fromEntries(details.map((d) => [d.property.id, d.commissionRules as any[]])) as Record<string, any[]> };
};
const currentRule = (rules: any[] = []) => [...rules].reverse().find((r) => r.effectiveFrom <= today() && (!r.effectiveTo || r.effectiveTo >= today())) ?? rules[rules.length - 1];

export function Properties() {
  const { can } = useSession();
  const nav = useNavigate();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const q = useLoad(loadAll, []);
  return (
    <Page title="Properties" sub="Listings you manage and the owner of each" actions={can('properties:write') && <button className="btn primary" onClick={() => setAdding(true)}>Add property</button>}>
      <Loaded q={q}>{({ properties, owners, rules }) => (
        <>
          <Card flush>
            {properties.length === 0 ? <Empty>No properties yet.{owners.length === 0 ? ' Add an owner first.' : ''}</Empty> : (
              <table><thead><tr><th>Property</th><th>Owner</th><th>Airbnb listing</th><th>Commission</th><th>Status</th></tr></thead><tbody>
                {properties.map((p) => { const r = currentRule(rules[p.id]); return (
                  <tr key={p.id} className="click" onClick={() => nav(`/properties/${p.id}`)}>
                    <td><Link to={`/properties/${p.id}`} onClick={(e) => e.stopPropagation()}><b>{p.name}</b></Link><div className="muted small">{[p.address, p.city, p.state].filter(Boolean).join(', ')}</div></td>
                    <td>{owners.find((o) => o.id === p.ownerId)?.displayName}</td>
                    <td>{p.airbnbListingName ?? <Badge tone="warn">Not set</Badge>}</td>
                    <td>{r ? describeRule(r) : <Badge tone="bad">No commission rule</Badge>}</td>
                    <td><StatusBadge status={p.active ? 'ACTIVE' : 'INACTIVE'} /></td>
                  </tr>); })}</tbody></table>)}
          </Card>
          {adding && <Modal title="Add property" wide onClose={() => setAdding(false)}>{owners.length === 0 ? <Note tone="warn">Add an owner first.</Note> : <PropertyForm owners={owners} onCancel={() => setAdding(false)} onSaved={(id) => { toast('Property added'); nav(`/properties/${id}`); }} />}</Modal>}
        </>)}
      </Loaded>
    </Page>
  );
}

export function PropertyDetail() {
  const { id } = useParams();
  const { can } = useSession();
  const toast = useToast();
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') ?? 'overview';
  const ym = sp.get('ym') ?? currentYm();
  const [editing, setEditing] = useState(false);
  const [changing, setChanging] = useState(false);
  const q = useLoad(async () => { const [p, o] = await Promise.all([api.get(`/api/properties/${id}`), api.get('/api/owners')]); return { property: p.property as any, commissionRules: p.commissionRules as any[], owners: o.owners as any[] }; }, [id]);
  const tabs = [['overview', 'Overview'], ['revenue', 'Revenue'], ['expenses', 'Expenses'], ['commission', 'Commission'], ['statements', 'Statements']];
  return (
    <Page title="Property" actions={can('properties:write') && <button className="btn" onClick={() => setEditing(true)}>Edit property</button>}>
      <Loaded q={q}>{({ property: p, commissionRules, owners }) => (<>
        <h2 style={{ marginTop: -8 }}>{p.name} {!p.active && <Badge>Inactive</Badge>}</h2>
        <p className="muted" style={{ marginTop: 4 }}>{owners.find((o) => o.id === p.ownerId)?.displayName} · {[p.address, p.city, p.state, p.zip].filter(Boolean).join(', ')}</p>
        <div className="tabs" role="tablist">{tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setSp({ tab: k, ym })}>{l}</button>)}</div>
        {tab === 'overview' && <Card><dl className="dl">
          <dt>Owner</dt><dd><Link to={`/owners/${p.ownerId}`}>{owners.find((o) => o.id === p.ownerId)?.displayName}</Link></dd>
          <dt>Airbnb listing</dt><dd>{p.airbnbListingName ?? '—'}{p.airbnbListingId ? <span className="muted"> (ID {p.airbnbListingId})</span> : ''}</dd>
          <dt>Management period</dt><dd>{fmtDate(p.managementStartDate)} → {p.managementEndDate ? fmtDate(p.managementEndDate) : 'ongoing'}</dd>
          <dt>Current commission</dt><dd>{currentRule(commissionRules) ? describeRule(currentRule(commissionRules)) : <Badge tone="bad">None: statements cannot be generated</Badge>}</dd>
          <dt>Notes</dt><dd>{p.notes ?? '—'}</dd></dl></Card>}
        {tab === 'revenue' && <PropertyRevenue id={p.id} ym={ym} setYm={(v) => setSp({ tab, ym: v })} />}
        {tab === 'expenses' && <PropertyExpenses id={p.id} ym={ym} setYm={(v) => setSp({ tab, ym: v })} />}
        {tab === 'commission' && <Card title="Commission history" actions={can('commission:write') && <button className="btn primary sm" onClick={() => setChanging(true)}>Change commission</button>} flush>
          {commissionRules.length === 0 ? <Empty>No commission rule yet. Statements cannot be generated for this property until one is set.</Empty> : <table><thead><tr><th>Rule</th><th>Cleaning fees</th><th>Taxes</th><th>Effective</th></tr></thead><tbody>
            {[...commissionRules].reverse().map((r) => <tr key={r.id}><td>{describeRule(r)}</td><td>{r.includeCleaningFees ? 'Included' : 'Excluded'}</td><td>{r.excludeTaxes ? 'Excluded' : 'Included'}</td><td>{fmtDate(r.effectiveFrom)} → {r.effectiveTo ? fmtDate(r.effectiveTo) : <Badge tone="good">Current</Badge>}</td></tr>)}</tbody></table>}
        </Card>}
        {tab === 'statements' && <PropertyStatements id={p.id} />}
        {editing && <Modal title="Edit property" wide onClose={() => setEditing(false)}><PropertyForm owners={owners} id={p.id} initial={p} onCancel={() => setEditing(false)} onSaved={() => { setEditing(false); toast('Property updated'); q.reload(); }} /></Modal>}
        {changing && <Modal title="Change commission" onClose={() => setChanging(false)}><CommissionForm propertyId={p.id} current={currentRule(commissionRules)} onCancel={() => setChanging(false)} onSaved={() => { setChanging(false); toast('Commission updated'); q.reload(); }} /></Modal>}
      </>)}</Loaded>
    </Page>
  );
}

function PropertyRevenue({ id, ym, setYm }: { id: string; ym: string; setYm: (v: string) => void }) {
  const q = useLoad(() => api.get(`/api/revenue${qs({ ym, propertyId: id })}`), [id, ym]);
  return <><div className="toolbar"><MonthPicker value={ym} onChange={setYm} /></div><Loaded q={q}>{(d) => (
    <Card flush>{d.rows.length === 0 ? <Empty>No Airbnb revenue imported for {fmtMonth(ym)}.</Empty> : <table><thead><tr><th>Date</th><th>Type</th><th>Reservation</th><th className="r">Booking revenue</th><th className="r">Net payout</th></tr></thead><tbody>
      {d.rows.map((r: any) => <tr key={r.id}><td>{fmtDate(r.earningsDate)}</td><td>{r.kind.replace(/_/g, ' ').toLowerCase()}</td><td>{r.reservationId ?? '—'}</td><td className="r"><Money cents={r.grossBookingCents} /></td><td className="r"><Money cents={r.netPayoutCents} /></td></tr>)}</tbody>
      <tfoot><tr><td colSpan={3}>Total</td><td className="r"><Money cents={d.totals.grossBookingCents} /></td><td className="r"><Money cents={d.totals.netPayoutCents} /></td></tr></tfoot></table>}</Card>)}</Loaded></>;
}

function PropertyExpenses({ id, ym, setYm }: { id: string; ym: string; setYm: (v: string) => void }) {
  const q = useLoad(() => api.get(`/api/expenses${qs({ ym, propertyId: id })}`), [id, ym]);
  return <><div className="toolbar"><MonthPicker value={ym} onChange={setYm} /></div><Loaded q={q}>{(d) => (
    <Card flush>{d.expenses.length === 0 ? <Empty>No expenses for {fmtMonth(ym)}.</Empty> : <table><thead><tr><th>Date</th><th>Vendor</th><th>Category</th><th className="r">Amount</th></tr></thead><tbody>
      {d.expenses.map((e: any) => <tr key={e.id}><td>{fmtDate(e.date)}</td><td><Link to={`/expenses/${e.id}`}>{e.vendor}</Link></td><td>{e.category}</td><td className="r"><Money cents={e.amountCents + e.taxCents} /></td></tr>)}</tbody>
      <tfoot><tr><td colSpan={3}>Charged to owner</td><td className="r"><Money cents={d.totals.chargedCents} /></td></tr></tfoot></table>}</Card>)}</Loaded></>;
}

function PropertyStatements({ id }: { id: string }) {
  const q = useLoad(() => api.get(`/api/statements?propertyId=${id}`), [id]);
  return <Loaded q={q}>{(d) => <Card flush>{d.statements.length === 0 ? <Empty>No statements yet.</Empty> : <table><thead><tr><th>Statement</th><th className="r">Net payout</th><th className="r">Commission</th><th className="r">Owner proceeds</th><th>Status</th></tr></thead><tbody>
    {[...d.statements].reverse().map((s: any) => <tr key={s.id}><td><Link to={`/statements/${s.id}`}>{fmtMonth(`${s.year}-${String(s.month).padStart(2, '0')}`)}</Link></td><td className="r"><Money cents={s.netPayoutCents} /></td><td className="r"><Money cents={s.commissionCents} /></td><td className="r"><Money cents={s.ownerProceedsCents} strong /></td><td><StatusBadge status={s.status} /></td></tr>)}</tbody></table>}</Card>}</Loaded>;
}

export function CommissionPage() {
  const { can } = useSession();
  const toast = useToast();
  const [target, setTarget] = useState<any>(null);
  const q = useLoad(loadAll, []);
  return (
    <Page title="Commission settings" sub="The management fee agreed for each property">
      <Note>Changing a commission applies from its effective date forward. Earlier months and finalized statements keep the rate they were calculated with.</Note>
      <Loaded q={q}>{({ properties, owners, rules }) => (<>
        <Card flush><table><thead><tr><th>Property</th><th>Owner</th><th>Commission</th><th>Cleaning fees</th><th>Since</th><th /></tr></thead><tbody>
          {properties.map((p) => { const r = currentRule(rules[p.id]); return (
            <tr key={p.id}><td><Link to={`/properties/${p.id}?tab=commission`}>{p.name}</Link></td><td>{owners.find((o) => o.id === p.ownerId)?.displayName}</td>
              <td>{r ? describeRule(r) : <Badge tone="bad">Not set</Badge>}</td><td>{r ? (r.includeCleaningFees ? 'Included' : 'Excluded') : '—'}</td><td>{r ? fmtDate(r.effectiveFrom) : '—'}</td>
              <td className="r">{can('commission:write') && <button className="btn sm" onClick={() => setTarget({ p, r })}>{r ? 'Change' : 'Set'}</button>}</td></tr>); })}</tbody></table></Card>
        {target && <Modal title={`Commission: ${target.p.name}`} onClose={() => setTarget(null)}><CommissionForm propertyId={target.p.id} current={target.r} onCancel={() => setTarget(null)} onSaved={() => { setTarget(null); toast('Commission updated'); q.reload(); }} /></Modal>}
      </>)}</Loaded>
    </Page>
  );
}
