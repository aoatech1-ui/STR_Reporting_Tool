import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useSession } from '../auth';
import { fmtMonth, ymOf } from '../format';
import { Badge, Card, Empty, Field, Kpi, Loaded, Modal, Money, Note, Page, StatusBadge, useAction, useLoad, useToast } from '../ui';

const blank = { legalName: '', displayName: '', email: '', secondaryEmail: '', emailEnabled: true, phone: '', whatsappPhone: '', whatsappEnabled: false, whatsappOptIn: false, mailingAddress: '', taxReportingName: '', notes: '', active: true };
type OwnerValues = typeof blank;

const clean = (v: OwnerValues) => Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x === '' ? null : x]));

export function OwnerForm({ initial, onSaved, onCancel, id }: { initial?: Partial<OwnerValues>; id?: string; onSaved: () => void; onCancel: () => void }) {
  const [v, setV] = useState<OwnerValues>({ ...blank, ...Object.fromEntries(Object.entries(initial ?? {}).map(([k, x]) => [k, x ?? ''])) } as OwnerValues);
  const { busy, error, run } = useAction();
  const set = <K extends keyof OwnerValues>(k: K, x: OwnerValues[K]) => setV((s) => ({ ...s, [k]: x }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await run(async () => { id ? await api.patch(`/api/owners/${id}`, clean(v)) : await api.post('/api/owners', clean(v)); return true; });
    if (ok) onSaved();
  };
  return (
    <form onSubmit={submit}>
      {error && <div className="alert bad" role="alert">{error}</div>}
      <div className="form-grid">
        <Field label="Legal name"><input value={v.legalName} onChange={(e) => set('legalName', e.target.value)} required /></Field>
        <Field label="Display name"><input value={v.displayName} onChange={(e) => set('displayName', e.target.value)} required /></Field>
        <Field label="Primary email"><input type="email" value={v.email} onChange={(e) => set('email', e.target.value)} /></Field>
        <Field label="Secondary email (optional)"><input type="email" value={v.secondaryEmail} onChange={(e) => set('secondaryEmail', e.target.value)} /></Field>
        <Field label="Phone"><input value={v.phone} onChange={(e) => set('phone', e.target.value)} /></Field>
        <Field label="WhatsApp number" hint="International format, e.g. +15551234567"><input value={v.whatsappPhone} onChange={(e) => set('whatsappPhone', e.target.value)} /></Field>
        <label className="field check wide"><input type="checkbox" checked={v.emailEnabled} onChange={(e) => set('emailEnabled', e.target.checked)} /><span>Send statements by email</span></label>
        <label className="field check"><input type="checkbox" checked={v.whatsappEnabled} onChange={(e) => set('whatsappEnabled', e.target.checked)} /><span>WhatsApp notifications</span></label>
        <label className="field check"><input type="checkbox" checked={v.whatsappOptIn} onChange={(e) => set('whatsappOptIn', e.target.checked)} /><span>Owner has opted in to WhatsApp</span></label>
        <Field label="Mailing address" wide><textarea rows={2} value={v.mailingAddress} onChange={(e) => set('mailingAddress', e.target.value)} /></Field>
        <Field label="Tax reporting name" hint="Name only. Do not store tax ID numbers here."><input value={v.taxReportingName} onChange={(e) => set('taxReportingName', e.target.value)} /></Field>
        {id && <label className="field check"><input type="checkbox" checked={v.active} onChange={(e) => set('active', e.target.checked)} /><span>Active</span></label>}
        <Field label="Notes" wide><textarea rows={2} value={v.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
      </div>
      <div className="form-actions"><button type="button" className="btn" onClick={onCancel}>Cancel</button><button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Save owner'}</button></div>
    </form>
  );
}

export function Owners() {
  const { can } = useSession();
  const nav = useNavigate();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const q = useLoad(async () => { const [o, p] = await Promise.all([api.get('/api/owners'), api.get('/api/properties')]); return { owners: o.owners as any[], properties: p.properties as any[] }; }, []);
  return (
    <Page title="Owners" sub="People and entities whose properties you manage" actions={can('owners:write') && <button className="btn primary" onClick={() => setAdding(true)}>Add owner</button>}>
      <Loaded q={q}>{({ owners, properties }) => (
        <Card flush>
          {owners.length === 0 ? <Empty>No owners yet. Add your first owner to get started.</Empty> : (
            <table>
              <thead><tr><th>Owner</th><th>Email</th><th>Properties</th><th>Statement delivery</th><th>Status</th></tr></thead>
              <tbody>{owners.map((o) => (
                <tr key={o.id} className="click" onClick={() => nav(`/owners/${o.id}`)}>
                  <td><Link to={`/owners/${o.id}`} onClick={(e) => e.stopPropagation()}><b>{o.displayName}</b></Link><div className="muted small">{o.legalName !== o.displayName ? o.legalName : ''}</div></td>
                  <td>{o.email ?? <span className="muted">—</span>}</td>
                  <td>{properties.filter((p) => p.ownerId === o.id).map((p) => p.name).join(', ') || <span className="muted">None</span>}</td>
                  <td>{o.emailEnabled ? <Badge tone="info">Email</Badge> : null} {o.whatsappEnabled ? <Badge tone={o.whatsappOptIn ? 'good' : 'warn'}>{o.whatsappOptIn ? 'WhatsApp' : 'WhatsApp (no opt-in)'}</Badge> : null}</td>
                  <td><StatusBadge status={o.active ? 'ACTIVE' : 'INACTIVE'} /></td>
                </tr>))}</tbody>
            </table>)}
        </Card>)}
      </Loaded>
      {adding && <Modal title="Add owner" wide onClose={() => setAdding(false)}><OwnerForm onCancel={() => setAdding(false)} onSaved={() => { setAdding(false); toast('Owner added'); q.reload(); }} /></Modal>}
    </Page>
  );
}

export function OwnerDetail() {
  const { id } = useParams();
  const { can } = useSession();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const q = useLoad(async () => {
    const year = new Date().getUTCFullYear();
    const [o, s, a] = await Promise.all([api.get(`/api/owners/${id}`), api.get(`/api/statements?ownerId=${id}`), api.get(`/api/annual?year=${year}&ownerId=${id}`)]);
    return { owner: o.owner, properties: o.properties as any[], statements: s.statements as any[], annual: a.report, year };
  }, [id]);
  return (
    <Page title="Owner" actions={can('owners:write') && <button className="btn" onClick={() => setEditing(true)}>Edit owner</button>}>
      <Loaded q={q}>{({ owner, properties, statements, annual, year }) => {
        return (<>
          <h2 style={{ marginTop: -8, marginBottom: 14 }}>{owner.displayName} {!owner.active && <Badge>Inactive</Badge>}</h2>
          <div className="grid k3">
            <Kpi label={`${year} owner proceeds (finalized)`} value={<Money cents={annual.totals.ownerProceedsCents} />} tone="info" />
            <Kpi label={`${year} management commissions`} value={<Money cents={annual.totals.commissionCents} />} />
            <Kpi label="Properties" value={String(properties.length)} />
          </div>
          <div className="grid k2" style={{ marginTop: 18 }}>
            <Card title="Contact">
              <dl className="dl">
                <dt>Legal name</dt><dd>{owner.legalName}</dd><dt>Email</dt><dd>{owner.email ?? '—'}{owner.secondaryEmail ? `, ${owner.secondaryEmail}` : ''}</dd>
                <dt>Phone</dt><dd>{owner.phone ?? '—'}</dd><dt>Mailing address</dt><dd>{owner.mailingAddress ?? '—'}</dd>
                <dt>Tax reporting name</dt><dd>{owner.taxReportingName ?? '—'}</dd><dt>Notes</dt><dd>{owner.notes ?? '—'}</dd>
              </dl>
            </Card>
            <Card title="Delivery preferences">
              <dl className="dl">
                <dt>Email</dt><dd>{owner.emailEnabled ? (owner.email ? <Badge tone="good">Enabled</Badge> : <Badge tone="warn">Enabled, no address</Badge>) : <Badge>Off</Badge>}</dd>
                <dt>WhatsApp</dt><dd>{owner.whatsappEnabled ? <Badge tone={owner.whatsappOptIn ? 'good' : 'warn'}>{owner.whatsappOptIn ? 'Enabled, opted in' : 'Enabled, awaiting opt-in'}</Badge> : <Badge>Off</Badge>}</dd>
                <dt>WhatsApp number</dt><dd>{owner.whatsappPhone ?? '—'}</dd>
              </dl>
              <p className="muted small" style={{ marginBottom: 0 }}>WhatsApp messages never include dollar amounts unless enabled; the full statement is behind a secure link.</p>
            </Card>
          </div>
          <Card title="Properties" flush>
            {properties.length === 0 ? <Empty>No properties for this owner.</Empty> : <table><thead><tr><th>Property</th><th>Address</th><th>Airbnb listing</th></tr></thead><tbody>
              {properties.map((p) => <tr key={p.id}><td><Link to={`/properties/${p.id}`}>{p.name}</Link></td><td>{[p.address, p.city, p.state].filter(Boolean).join(', ') || '—'}</td><td>{p.airbnbListingName ?? '—'}</td></tr>)}</tbody></table>}
          </Card>
          <Card title="Statement history" flush>
            {statements.length === 0 ? <Empty>No statements yet.</Empty> : <table><thead><tr><th>Statement</th><th>Property</th><th className="r">Net payout</th><th className="r">Owner proceeds</th><th>Status</th></tr></thead><tbody>
              {[...statements].reverse().map((s) => <tr key={s.id}><td><Link to={`/statements/${s.id}`}>{s.statementNumber}</Link><div className="muted small">{fmtMonth(ymOf(s.year, s.month))}</div></td><td>{s.propertyName}</td><td className="r"><Money cents={s.netPayoutCents} /></td><td className="r"><Money cents={s.ownerProceedsCents} strong /></td><td><StatusBadge status={s.status} /></td></tr>)}</tbody></table>}
          </Card>
          {editing && <Modal title="Edit owner" wide onClose={() => setEditing(false)}><OwnerForm id={owner.id} initial={owner} onCancel={() => setEditing(false)} onSaved={() => { setEditing(false); toast('Owner updated'); q.reload(); }} /></Modal>}
          {!can('owners:write') && <Note>You have read-only access.</Note>}
        </>);
      }}</Loaded>
    </Page>
  );
}
