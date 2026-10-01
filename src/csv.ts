/** Minimal RFC 4180 parser (quotes, embedded commas/newlines, CRLF, BOM). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', inQ = false;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  return rows;
}

/** Deterministic writer. Text cells starting with = + - @ are prefixed with ' (CSV/formula injection). */
export function csvCell(v: string | number, opts: { numeric?: boolean } = {}): string {
  let s = String(v);
  if (!opts.numeric && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function writeCsv(header: string[], rows: (string | { n: string })[][]): string {
  const line = (r: (string | { n: string })[]) =>
    r.map((c) => (typeof c === 'string' ? csvCell(c) : csvCell(c.n, { numeric: true }))).join(',');
  return [header.map((h) => csvCell(h)).join(','), ...rows.map(line)].join('\r\n') + '\r\n';
}
