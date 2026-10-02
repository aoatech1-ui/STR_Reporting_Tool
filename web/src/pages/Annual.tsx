import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { fmtDate, monthName } from '../format';
import { Card, Empty, Kpi, Loaded, Money, Note, Page, useLoad } from '../ui';

export function Annual() {
  const [sp, setSp] = useSearchParams();
  const year = sp.get('year') ?? String(new Date().getUTCFullYear());
  const ownerId = sp.get('ownerId') ?? '';
  const owners = useLoad(() => api.get('/api/owners'), []);
  const q = useLoad(() => (ownerId ? api.get(`/api/annual?year=${year}&ownerId=${ownerId}`) : Promise.resolve(null)), [year, ownerId]);
  const set = (o: Record<string, string>) => setSp({ year, ownerId, ...o });
  return (
    <Page title="Annual reports" sub="Year-end summary of income, expenses, commissions and owner proceeds"
      actions={q.data && <><button className="btn" onClick={() => window.print()}>Print / Save as PDF</button><a className="btn" href={`/api/exports/annual.csv?year=${year}&ownerId=${ownerId}`}>Download CSV</a></>}>
      <div className="toolbar no-print">
        <label className="inline-field"><span>Year</span><input type="number" min={2000} max={2100} value={year} onChange={(e) => set({ year: e.target.value })} style={{ width: 90 }} /></label>
        <label className="inline-field"><span>Owner</span><select value={ownerId} onChange={(e) => set({ ownerId: e.target.value })}><option value="">Select an owner…</option>{(owners.data?.owners ?? []).map((o: any) => <option key={o.id} value={o.id}>{o.displayName}</option>)}</select></label>
      </div>
      {!ownerId && <Card><Empty>Choose an owner to generate their annual report.</Empty></Card>}
      {ownerId && <Loaded q={q}>{(d) => {
        if (!d) return null;
        const r = d.report;
        return (<div className="doc" style={{ maxWidth: 980 }}>
          <div className="doc-head"><div><div className="org">{d.organization.displayName}</div><h1>Annual Owner Statement {r.year}</h1><div style={{ fontSize: 16, marginTop: 2 }}>{d.owner.displayName}</div></div>
            <div className="doc-meta"><div>Properties: {d.properties.join(', ') || '—'}</div><div>{r.statementCount} monthly statement(s)</div><div>Prepared {fmtDate(new Date().toISOString())}</div></div></div>
          {r.statementCount === 0 ? <Note tone="warn">No finalized statements exist for {r.year} yet.</Note> : null}
          <div className="grid k3" style={{ marginBottom: 6 }}>
            <Kpi label="Annual gross rental revenue" value={<Money cents={r.totals.grossCents} />} /><Kpi label="Annual Airbnb/platform fees" value={<Money cents={-r.totals.platformFeesCents} />} />
            <Kpi label="Annual property expenses" value={<Money cents={-r.totals.expensesCents} />} /><Kpi label="Annual management commissions" value={<Money cents={-r.totals.commissionCents} />} />
            <Kpi label="Annual owner net proceeds" value={<Money cents={r.totals.ownerProceedsCents} />} tone="accent" />
          </div>
          <h3>Monthly breakdown</h3>
          <table><thead><tr><th>Month</th><th className="r">Gross revenue</th><th className="r">Airbnb fees</th><th className="r">Net payout</th><th className="r">Expenses</th><th className="r">Commission</th><th className="r">Owner proceeds</th></tr></thead>
            <tbody>{r.months.map((m: any) => <tr key={m.month}><td>{monthName(m.month)}</td><td className="r"><Money cents={m.grossCents} /></td><td className="r"><Money cents={-m.platformFeesCents} /></td><td className="r"><Money cents={m.netPayoutCents} /></td><td className="r"><Money cents={-m.expensesCents} /></td><td className="r"><Money cents={-m.commissionCents} /></td><td className="r"><Money cents={m.ownerProceedsCents} /></td></tr>)}</tbody>
            <tfoot><tr><td>Total</td><td className="r"><Money cents={r.totals.grossCents} /></td><td className="r"><Money cents={-r.totals.platformFeesCents} /></td><td className="r"><Money cents={r.totals.netPayoutCents} /></td><td className="r"><Money cents={-r.totals.expensesCents} /></td><td className="r"><Money cents={-r.totals.commissionCents} /></td><td className="r"><Money cents={r.totals.ownerProceedsCents} strong /></td></tr></tfoot></table>
          <h3>Expenses by category</h3>
          {r.expenseCategories.length === 0 ? <p className="muted">No property expenses recorded.</p> : <table><tbody>{r.expenseCategories.map((c: any) => <tr key={c.category}><td>{c.category}</td><td className="r"><Money cents={c.cents} /></td></tr>)}</tbody><tfoot><tr><td>Total expenses</td><td className="r"><Money cents={r.totals.expensesCents} strong /></td></tr></tfoot></table>}
          <h3>How to read this report</h3>
          <p>{r.explanation}</p>
          <div className="disclaimer">{r.disclaimer}</div>
        </div>);
      }}</Loaded>}
    </Page>
  );
}
