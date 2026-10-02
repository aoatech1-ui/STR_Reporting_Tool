import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { currentYm, fmtMonth } from '../format';
import { Card, Kpi, Loaded, Money, MonthPicker, Page, useLoad, Badge } from '../ui';

export function Dashboard() {
  const [sp, setSp] = useSearchParams();
  const ym = sp.get('ym') ?? currentYm();
  const q = useLoad(() => api.get(`/api/dashboard?ym=${ym}`), [ym]);
  return (
    <Page title="Dashboard" sub={fmtMonth(ym)} actions={<MonthPicker value={ym} onChange={(v) => setSp({ ym: v })} />}>
      <Loaded q={q}>{(d) => {
        const items: { label: string; n: number; to: string; bad?: boolean }[] = [
          { label: 'Statements awaiting review', n: d.awaitingReview, to: `/close?ym=${ym}` },
          { label: 'Statements ready to send', n: d.readyToSend, to: '/statements?status=FINALIZED' },
          { label: 'Failed deliveries', n: d.failedDeliveries, to: '/communications?status=FAILED', bad: true },
          { label: 'Properties with no expenses this month', n: d.missingExpenses, to: `/expenses?ym=${ym}` },
          { label: 'Unmatched Airbnb transactions', n: d.unmatchedTransactions, to: '/import', bad: true },
          { label: 'Import rows that need attention', n: d.importErrors, to: '/import' },
        ];
        const open = items.filter((i) => i.n > 0).length;
        return (<>
          <div className="section-label">{fmtMonth(ym)}</div>
          <div className="grid k4">
            <Kpi label="Airbnb net revenue" value={<Money cents={d.month.revenueCents} />} sub="Net payouts earned this month" />
            <Kpi label="Property expenses" value={<Money cents={d.month.expensesCents} />} sub="Charged to owners" />
            <Kpi label="Management commissions" value={<Money cents={d.month.commissionsCents} />} sub="Manager revenue" tone="neutral" />
            <Kpi label="Owner distributions" value={<Money cents={d.month.ownerDistributionsCents} />} sub="Owner net proceeds" tone="info" />
          </div>
          <div className="section-label">Year to date</div>
          <div className="grid k4">
            <Kpi label="YTD revenue" value={<Money cents={d.ytd.revenueCents} />} />
            <Kpi label="YTD expenses" value={<Money cents={d.ytd.expensesCents} />} />
            <Kpi label="YTD commissions" value={<Money cents={d.ytd.commissionsCents} />} />
            <Kpi label="Portfolio" value={`${d.properties} properties`} sub={`${d.owners} owners`} />
          </div>
          <div className="section-label">Needs attention {open > 0 ? <Badge tone="warn">{open}</Badge> : <Badge tone="good">All clear</Badge>}</div>
          <div className="grid k2">
            <Card flush>
              {items.map((i) => (
                <Link key={i.label} to={i.to} className="attn"><span>{i.label}</span>{i.n > 0 ? <Badge tone={i.bad ? 'bad' : 'warn'}>{i.n}</Badge> : <Badge tone="good">0</Badge>}</Link>
              ))}
            </Card>
            <Card title={`Close ${fmtMonth(ym)}`}>
              <p style={{ marginTop: 0 }} className="muted">Import revenue, review expenses, generate the review, then finalize to lock the month and send statements.</p>
              <Link className="btn primary" to={`/close?ym=${ym}`}>Open monthly close</Link>
              <p className="muted small" style={{ marginBottom: 0 }}>Commission and distribution figures appear once statements are generated for the month.</p>
            </Card>
          </div>
        </>);
      }}</Loaded>
    </Page>
  );
}
