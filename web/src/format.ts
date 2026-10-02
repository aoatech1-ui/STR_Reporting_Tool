/** Display formatting only. All financial values arrive from the server as integer cents. */
export function fmtMoney(cents: number): string {
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${cents < 0 ? '-' : ''}$${whole}.${String(abs % 100).padStart(2, '0')}`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthName = (m: number) => MONTHS[m - 1];
export const fmtMonth = (ym: string) => `${MONTHS[+ym.slice(5, 7) - 1]} ${ym.slice(0, 4)}`;
export const ymOf = (year: number, month: number) => `${year}-${String(month).padStart(2, '0')}`;
export const currentYm = () => new Date().toISOString().slice(0, 7);

/** One date format everywhere: "Sep 5, 2026". */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}
export const fmtRate = (bps: number) => `${parseFloat((bps / 100).toFixed(2))}%`;

/** Parses user-typed dollars ("1,234.56", "$12", "-5") to integer cents; null if invalid. Input handling only, never arithmetic on balances. */
export function parseDollars(raw: string): number | null {
  const s = raw.trim().replace(/[$,\s]/g, '');
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const cents = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0') || 0);
  return m[1] ? -cents : cents;
}

export const COMMISSION_LABEL: Record<string, string> = {
  PERCENT_GROSS: '% of gross booking revenue', PERCENT_NET: '% of Airbnb net payout', FIXED: 'Fixed monthly amount', HYBRID: '% plus fixed amount',
};
