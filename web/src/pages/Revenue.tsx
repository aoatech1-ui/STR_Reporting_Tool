import { Link, useSearchParams } from 'react-router-dom';
import { api, qs } from '../api';
import { currentYm, fmtDate, fmtMonth } from '../format';
import { Card, Empty, Loaded, Money, MonthPicker, Note, Page, useLoad } from '../ui';

export function Revenue() {
  const [sp, setSp] = useSearchParams();
  const ym = sp.get('ym') ?? currentYm();
  const propertyId = sp.get('propertyId') ?? '';
  const props = useLoad(() => api.get('/api/properties'), []);
  const q = useLoad(() => api.get(`/api/revenue${qs({ ym, propertyId })}`), [ym, propertyId]);
  const set = (o: Record<string, string>) => setSp({ ym, propertyId, ...o });
  return (
    <Page title="Revenue" sub={`Airbnb earnings recorded for ${fmtMonth(ym)}`} actions={<Link className="btn" to="/import">Import Airbnb data</Link>}>
      <div className="toolbar">
        <MonthPicker value={ym} onChange={(v) => set({ ym: v })} />
        <label className="inline-field"><span>Property</span><select value={propertyId} onChange={(e) => set({ propertyId: e.target.value })}><option value="">All properties</option>{(props.data?.properties ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      </div>
      <Note>Booking revenue and Airbnb payout are tracked separately: the payout reflects Airbnb's fees, adjustments and refunds, so it will not equal the booking total.</Note>
      <Loaded q={q}>{(d) => (
        <Card flush>
          {d.rows.length === 0 ? <Empty>No revenue imported for this month. <Link to="/import">Import an Airbnb earnings export.</Link></Empty> : (
            <table>
              <thead><tr><th>Earned</th><th>Property</th><th>Type</th><th>Reservation</th><th>Stay</th><th className="r">Booking revenue</th><th className="r">Cleaning</th><th className="r">Airbnb fees</th><th className="r">Adjust. / refunds</th><th className="r">Net payout</th></tr></thead>
              <tbody>{d.rows.map((r: any) => (
                <tr key={r.id}><td className="nowrap">{fmtDate(r.earningsDate)}</td><td>{r.propertyName}</td><td>{r.kind.replace(/_/g, ' ').toLowerCase()}</td><td>{r.reservationId ?? '—'}</td>
                  <td className="nowrap">{r.checkIn ? `${fmtDate(r.checkIn)} → ${fmtDate(r.checkOut)}` : '—'}</td>
                  <td className="r"><Money cents={r.grossBookingCents} /></td><td className="r"><Money cents={r.cleaningFeeCents} /></td><td className="r"><Money cents={-r.platformFeeCents} /></td>
                  <td className="r"><Money cents={r.adjustmentCents + r.refundCents} /></td><td className="r"><Money cents={r.netPayoutCents} strong /></td></tr>))}</tbody>
              <tfoot><tr><td colSpan={5}>Total</td><td className="r"><Money cents={d.totals.grossBookingCents} /></td><td className="r"><Money cents={d.totals.cleaningFeeCents} /></td><td className="r"><Money cents={-d.totals.platformFeeCents} /></td><td className="r"><Money cents={d.totals.adjustmentCents + d.totals.refundCents} /></td><td className="r"><Money cents={d.totals.netPayoutCents} strong /></td></tr></tfoot>
            </table>)}
        </Card>)}</Loaded>
    </Page>
  );
}
