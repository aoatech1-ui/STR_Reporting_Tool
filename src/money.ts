/** All money is integer cents. Floats never touch a financial value. */
export type Cents = number;

/** Parses "$1,234.56", "-12.00", "(12.00)" to cents. Returns null if not a valid amount. */
export function parseMoney(raw: string | undefined | null): Cents | null {
  if (raw == null) return null;
  let s = raw.trim();
  if (s === '') return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
  s = s.replace(/^\$/, '').replace(/,/g, '').trim();
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || 0);
  if (!Number.isSafeInteger(cents)) return null;
  return neg ? -cents : cents;
}

/** cents × basis points (1% = 100 bps), rounded half away from zero. */
export function mulBps(cents: Cents, bps: number): Cents {
  const sign = cents < 0 ? -1 : 1;
  const r = (BigInt(Math.abs(cents)) * BigInt(bps) + 5000n) / 10000n;
  return sign * Number(r);
}

export function formatMoney(cents: Cents): string {
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${cents < 0 ? '-' : ''}$${whole}.${String(abs % 100).padStart(2, '0')}`;
}

/** Plain decimal for CSV: 4000.00 (no symbol, no grouping). */
export function toDecimal(cents: Cents): string {
  const abs = Math.abs(cents);
  return `${cents < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export function formatRate(bps: number): string {
  return `${parseFloat((bps / 100).toFixed(2))}%`;
}

export const sum = (xs: Cents[]): Cents => xs.reduce((a, b) => a + b, 0);
