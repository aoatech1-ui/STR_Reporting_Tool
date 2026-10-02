import { fmtDate, fmtMonth, fmtRate, ymOf } from './format';
import { Money } from './ui';

export interface DocProps {
  orgName: string; statementNumber: string; generatedAt?: string | null; ownerName: string; propertyName: string; propertyAddress?: string;
  statement: any; ytd: any; disclaimer: string; draft?: boolean;
}

/** The owner-facing statement. Renders server-calculated numbers only. */
export function StatementDoc({ orgName, statementNumber, generatedAt, ownerName, propertyName, propertyAddress, statement: s, ytd, disclaimer, draft }: DocProps) {
  const r = s.revenue, c = s.commission;
  const expenseLines = s.lines.filter((l: any) => l.type === 'EXPENSE');
  const earningLines = s.lines.filter((l: any) => l.type === 'EARNINGS');
  const adjLines = s.lines.filter((l: any) => l.type === 'ADJUSTMENT');
  return (
    <article className="doc" aria-label="Owner statement">
      <div className="doc-head">
        <div><div className="org">{orgName}</div><h1>Owner Statement</h1><div style={{ fontSize: 18, marginTop: 2 }}>{fmtMonth(ymOf(s.year, s.month))}</div></div>
        <div className="doc-meta"><div><b>{statementNumber}</b></div><div>Generated {fmtDate(generatedAt ?? undefined)}</div>{draft && <div style={{ color: '#b45309', fontWeight: 700, marginTop: 4 }}>DRAFT: not final</div>}</div>
      </div>
      <div className="party"><div><b>Owner</b>{ownerName}</div><div><b>Property</b>{propertyName}{propertyAddress && <div className="muted">{propertyAddress}</div>}</div></div>

      <h3>1. Airbnb activity</h3>
      <table><tbody>
        <tr><td>Gross booking revenue</td><td className="r"><Money cents={r.grossBookingCents} /></td></tr>
        <tr><td>Cleaning fees</td><td className="r"><Money cents={r.cleaningFeeCents} /></td></tr>
        {r.otherRevenueCents !== 0 && <tr><td>Other revenue</td><td className="r"><Money cents={r.otherRevenueCents} /></td></tr>}
        <tr><td>Airbnb service fees</td><td className="r"><Money cents={-r.platformFeeCents} /></td></tr>
        <tr><td>Adjustments</td><td className="r"><Money cents={r.adjustmentCents} /></td></tr>
        <tr><td>Refunds</td><td className="r"><Money cents={r.refundCents} /></td></tr>
      </tbody><tfoot><tr><td>Net Airbnb payout</td><td className="r"><Money cents={r.netPayoutCents} strong /></td></tr></tfoot></table>
      <p className="muted small" style={{ margin: '6px 0 0' }}>The net payout is the amount Airbnb paid out and is the basis for the calculation below. Booking revenue and payout differ because of fees, adjustments and refunds.</p>
      {earningLines.length > 0 && <details className="no-print" style={{ marginTop: 8 }}><summary className="small muted" style={{ cursor: 'pointer' }}>Show the {earningLines.length} Airbnb transaction(s) behind this total</summary>
        <table><tbody>{earningLines.map((l: any, i: number) => <tr key={i}><td>{fmtDate(l.date)}</td><td>{l.description.toLowerCase()}</td><td className="r"><Money cents={l.amountCents} /></td></tr>)}</tbody></table></details>}

      <h3>2. Property expenses</h3>
      {expenseLines.length === 0 ? <p className="muted">No property expenses this month.</p> : (
        <table><thead><tr><th>Date</th><th>Vendor and description</th><th>Category</th><th className="r">Amount</th></tr></thead>
          <tbody>{expenseLines.map((l: any, i: number) => <tr key={i}><td className="nowrap">{fmtDate(l.date)}</td><td>{l.description}</td><td>{l.category}</td><td className="r"><Money cents={-l.amountCents} /></td></tr>)}</tbody>
          <tfoot><tr><td colSpan={3}>Total property expenses</td><td className="r"><Money cents={s.expensesCents} strong /></td></tr></tfoot></table>)}

      <h3>3. Management fee</h3>
      <table><tbody>
        <tr><td>Commission basis</td><td className="r">{c.calculationBasis}</td></tr>
        {c.rule.type !== 'FIXED' && <tr><td>Commission rate</td><td className="r">{fmtRate(c.rateBps)}</td></tr>}
        {c.rule.type !== 'FIXED' && <tr><td>Base amount</td><td className="r"><Money cents={c.baseCents} /></td></tr>}
        {c.fixedCents > 0 && <tr><td>Fixed amount</td><td className="r"><Money cents={c.fixedCents} /></td></tr>}
      </tbody><tfoot><tr><td>Management fee</td><td className="r"><Money cents={c.commissionCents} strong /></td></tr></tfoot></table>
      <div className="calc">Management fee: {c.explanation}</div>

      <h3>4. Owner summary</h3>
      <table><tbody>
        <tr><td>Airbnb net revenue</td><td className="r"><Money cents={r.netPayoutCents} /></td></tr>
        <tr><td>Less: property expenses</td><td className="r"><Money cents={-s.expensesCents} /></td></tr>
        <tr><td>Less: management commission</td><td className="r"><Money cents={-c.commissionCents} /></td></tr>
        {adjLines.map((l: any, i: number) => <tr key={i}><td>Adjustment: {l.description}</td><td className="r"><Money cents={l.amountCents} /></td></tr>)}
      </tbody></table>
      <div className="proceeds"><span>OWNER NET PROCEEDS</span><Money cents={s.ownerProceedsCents} /></div>
      {s.ownerPaidExpensesCents > 0 && <p className="muted small">Expenses you paid directly ({<Money cents={s.ownerPaidExpensesCents} />}) are shown above for reference and are not deducted.</p>}

      <h3>5. Year to date ({s.year})</h3>
      <table><tbody>
        <tr><td>YTD gross revenue</td><td className="r"><Money cents={ytd.grossCents} /></td></tr>
        <tr><td>YTD Airbnb fees</td><td className="r"><Money cents={-ytd.platformFeesCents} /></td></tr>
        <tr><td>YTD property expenses</td><td className="r"><Money cents={-ytd.expensesCents} /></td></tr>
        <tr><td>YTD management commissions</td><td className="r"><Money cents={-ytd.commissionsCents} /></td></tr>
      </tbody><tfoot><tr><td>YTD owner proceeds</td><td className="r"><Money cents={ytd.ownerProceedsCents} strong /></td></tr></tfoot></table>

      <div className="disclaimer">{disclaimer}<br />Statement {statementNumber}</div>
    </article>
  );
}
