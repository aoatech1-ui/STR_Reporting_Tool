import PDFDocument from 'pdfkit';
import type { AnnualReport } from '../accounting/annual.ts';
import type { Statement, YtdTotals } from '../accounting/statement.ts';
import { formatMoney, formatRate } from '../money.ts';

const TEAL = '#0f766e', INK = '#0f172a', MUTED = '#64748b', RED = '#b91c1c', LINE = '#e2e8f0', SHADE = '#f1f5f9';
const PAGE_W = 612, PAGE_H = 792, L = 54, W = PAGE_W - 2 * L, TOP = 54, BOTTOM = PAGE_H - 62;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Standard PDF fonts cover Latin-1 + a few typographic marks. Anything else would render as garbage, so it becomes "?". */
export function pdfText(s: string): string {
  return s.replace(/−/g, '-').replace(/→/g, '->').replace(/[  ]/g, ' ').replace(/[^\x20-\x7E¡-ÿ–—‘’“”•…€\n]/g, '?');
}
const fmtDate = (iso: string | null | undefined) => {
  if (!iso) return '-';
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
};

type Cell = string | { t: string; color?: string; bold?: boolean };
interface Col { label: string; w: number; align?: 'left' | 'right' }
const cellText = (c: Cell) => pdfText(typeof c === 'string' ? c : c.t);
const money = (cents: number, bold = false): Cell => ({ t: formatMoney(cents), color: cents < 0 ? RED : INK, bold });

class Page {
  doc: PDFKit.PDFDocument; y = TOP;
  constructor(doc: PDFKit.PDFDocument) { this.doc = doc; }
  need(h: number) { if (this.y + h > BOTTOM) { this.doc.addPage(); this.y = TOP; } }
  font(bold: boolean, size: number, color: string) { this.doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(color); }
  h3(text: string) {
    this.need(40); this.y += 14;
    this.font(true, 8.5, TEAL); this.doc.text(pdfText(text.toUpperCase()), L, this.y, { characterSpacing: 1, lineBreak: false });
    this.y += 16;
  }
  para(text: string, o: { size?: number; color?: string; bold?: boolean } = {}) {
    this.font(!!o.bold, o.size ?? 9.5, o.color ?? INK);
    const t = pdfText(text), h = this.doc.heightOfString(t, { width: W });
    this.need(h + 4); this.doc.text(t, L, this.y, { width: W }); this.y += h + 6;
  }
  rule(color = LINE, width = 0.5) { this.doc.moveTo(L, this.y).lineTo(L + W, this.y).lineWidth(width).strokeColor(color).stroke(); }

  /** Generic table. Rows grow with wrapped text and the header repeats after a page break. */
  table(cols: Col[], rows: Cell[][], opts: { total?: Cell[]; size?: number } = {}) {
    const size = opts.size ?? 9.5, pad = 5;
    const header = () => {
      this.need(24);
      this.doc.rect(L, this.y, W, 20).fill(SHADE);
      let x = L;
      for (const c of cols) { this.font(true, 7.5, MUTED); this.doc.text(pdfText(c.label.toUpperCase()), x + 6, this.y + 6.5, { width: c.w - 12, align: c.align ?? 'left', characterSpacing: 0.4, lineBreak: false }); x += c.w; }
      this.y += 20;
    };
    const draw = (cells: Cell[], bold: boolean, shade: boolean, topRule: boolean) => {
      let h = 0;
      cells.forEach((c, i) => { this.font(bold || (typeof c !== 'string' && !!c.bold), size, INK); h = Math.max(h, this.doc.heightOfString(cellText(c), { width: cols[i].w - 12 })); });
      h += pad * 2;
      if (this.y + h > BOTTOM) { this.doc.addPage(); this.y = TOP; header(); }
      if (shade) this.doc.rect(L, this.y, W, h).fill(SHADE);
      if (topRule) { this.doc.moveTo(L, this.y).lineTo(L + W, this.y).lineWidth(1).strokeColor('#94a3b8').stroke(); }
      let x = L;
      cells.forEach((c, i) => {
        const o = typeof c === 'string' ? { t: c } : c;
        this.font(bold || !!o.bold, size, o.color ?? INK);
        this.doc.text(pdfText(o.t), x + 6, this.y + pad, { width: cols[i].w - 12, align: cols[i].align ?? 'left' });
        x += cols[i].w;
      });
      this.y += h;
      this.doc.moveTo(L, this.y).lineTo(L + W, this.y).lineWidth(0.5).strokeColor(LINE).stroke();
    };
    header();
    for (const r of rows) draw(r, false, false, false);
    if (opts.total) draw(opts.total, true, true, true);
    this.y += 4;
  }
  /** label/amount list (two columns). */
  kv(rows: [string, Cell][], total?: [string, Cell]) {
    for (const [a, b] of rows) { this.need(22); this.drawKv([a, b], false, false); }
    if (total) { this.need(26); this.drawKv([total[0], total[1]], true, true); }
    this.y += 4;
  }
  private drawKv(cells: Cell[], bold: boolean, shade: boolean) {
    const h = 19;
    if (shade) { this.doc.rect(L, this.y, W, h).fill(SHADE); this.doc.moveTo(L, this.y).lineTo(L + W, this.y).lineWidth(1).strokeColor('#94a3b8').stroke(); }
    const [a, b] = cells.map((c) => (typeof c === 'string' ? { t: c } : c));
    this.font(bold, 9.5, INK); this.doc.text(pdfText(a.t), L + 6, this.y + 6, { width: W - 170, lineBreak: false });
    this.font(bold || !!b.bold, 9.5, b.color ?? INK); this.doc.text(pdfText(b.t), L + W - 156, this.y + 6, { width: 150, align: 'right', lineBreak: false });
    this.y += h;
    this.doc.moveTo(L, this.y).lineTo(L + W, this.y).lineWidth(0.5).strokeColor(LINE).stroke();
  }
}

function open(title: string, author: string, createdAt: string, compress: boolean) {
  const created = new Date(createdAt);
  const doc = new PDFDocument({ size: 'LETTER', margins: { top: TOP, bottom: 62, left: L, right: L }, bufferPages: true, compress,
    info: { Title: pdfText(title), Author: pdfText(author), Producer: 'STR Owner Accounting', CreationDate: created, ModDate: created } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res, rej) => { doc.on('end', () => res(Buffer.concat(chunks))); doc.on('error', rej); });
  return { doc, page: new Page(doc), done };
}

/** Footer (id + page x of y) and optional DRAFT watermark on every page. */
function finish(doc: PDFKit.PDFDocument, label: string, draft: boolean) {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0; // otherwise text this low would trigger an automatic new page
    doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(pdfText(`${label}   |   Page ${i + 1} of ${range.count}`), L, PAGE_H - 40, { width: W, align: 'center', lineBreak: false });
    if (draft) {
      doc.save(); doc.rotate(-35, { origin: [PAGE_W / 2, PAGE_H / 2] });
      doc.fillColor('#b45309').opacity(0.1).font('Helvetica-Bold').fontSize(120).text('DRAFT', 90, PAGE_H / 2 - 60, { lineBreak: false });
      doc.restore(); doc.opacity(1);
    }
  }
  doc.end();
}

function masthead(p: Page, o: { org: string; title: string; subtitle: string; right: string[] }) {
  const { doc } = p;
  p.font(true, 9, TEAL); doc.text(pdfText(o.org.toUpperCase()), L, TOP, { characterSpacing: 1.4, lineBreak: false });
  p.font(true, 24, INK); doc.text(pdfText(o.title), L, TOP + 14, { lineBreak: false });
  p.font(false, 13, INK); doc.text(pdfText(o.subtitle), L, TOP + 44, { lineBreak: false });
  o.right.forEach((t, i) => { p.font(i === 0, 9, i === 0 ? INK : MUTED); doc.text(pdfText(t), L, TOP + 2 + i * 13, { width: W, align: 'right', lineBreak: false }); });
  p.y = TOP + 68; p.rule(TEAL, 2.5); p.y += 16;
}

export interface StatementPdfInput {
  orgName: string; statementNumber: string; generatedAt: string; ownerName: string; propertyName: string; propertyAddress?: string;
  statement: Statement; ytd: YtdTotals; disclaimer: string; draft?: boolean;
}

export async function renderStatementPdf(i: StatementPdfInput, o: { compress?: boolean } = {}): Promise<Buffer> {
  const s = i.statement, r = s.revenue, c = s.commission;
  const { doc, page: p, done } = open(`Owner Statement ${i.statementNumber}`, i.orgName, i.generatedAt, o.compress ?? true);
  masthead(p, { org: i.orgName, title: 'Owner Statement', subtitle: `${MONTHS[s.month - 1]} ${s.year}`, right: [i.statementNumber, `Generated ${fmtDate(i.generatedAt)}`, ...(i.draft ? ['DRAFT - not final'] : [])] });

  // parties
  p.font(true, 7.5, MUTED); doc.text('OWNER', L, p.y, { characterSpacing: 1, lineBreak: false }); doc.text('PROPERTY', L + W / 2, p.y, { characterSpacing: 1, lineBreak: false });
  p.font(false, 10.5, INK); doc.text(pdfText(i.ownerName), L, p.y + 12, { width: W / 2 - 10 });
  const ph = (() => { doc.text(pdfText(i.propertyName), L + W / 2, p.y + 12, { width: W / 2 }); if (i.propertyAddress) { p.font(false, 9.5, MUTED); doc.text(pdfText(i.propertyAddress), L + W / 2, doc.y, { width: W / 2 }); } return doc.y; })();
  p.y = Math.max(ph, p.y + 30) + 4;

  p.h3('1. Airbnb activity');
  p.kv([['Gross booking revenue', money(r.grossBookingCents)], ['Cleaning fees', money(r.cleaningFeeCents)],
    ...(r.otherRevenueCents !== 0 ? [['Other revenue', money(r.otherRevenueCents)] as [string, Cell]] : []),
    ['Airbnb service fees', money(-r.platformFeeCents)], ['Adjustments', money(r.adjustmentCents)], ['Refunds', money(r.refundCents)]],
    ['Net Airbnb payout', money(r.netPayoutCents, true)]);
  p.para('The net payout is the amount Airbnb paid out and is the basis for the calculation below. Booking revenue and payout differ because of fees, adjustments and refunds.', { size: 8, color: MUTED });

  p.h3('2. Property expenses');
  const exp = s.lines.filter((l) => l.type === 'EXPENSE');
  if (exp.length === 0) p.para('No property expenses this month.', { color: MUTED });
  else p.table([{ label: 'Date', w: 70 }, { label: 'Vendor and description', w: 232 }, { label: 'Category', w: 100 }, { label: 'Amount', w: 102, align: 'right' }],
    exp.map((l) => [fmtDate(l.date), l.description, l.category ?? '', money(-l.amountCents)]),
    { total: ['', 'Total property expenses', '', money(s.expensesCents, true)] });

  p.need(150); // keep the fee table and its calculation together
  p.h3('3. Management fee');
  p.kv([['Commission basis', c.calculationBasis], ...(c.rule.type !== 'FIXED' ? [['Commission rate', formatRate(c.rateBps)] as [string, Cell], ['Base amount', money(c.baseCents)] as [string, Cell]] : []),
    ...(c.fixedCents > 0 ? [['Fixed amount', money(c.fixedCents)] as [string, Cell]] : [])], ['Management fee', money(c.commissionCents, true)]);
  p.need(30); doc.rect(L, p.y, W, 22).fill(SHADE); p.font(false, 9.5, INK); doc.text(pdfText(`Management fee: ${c.explanation}`), L + 8, p.y + 6.5, { width: W - 16, lineBreak: false }); p.y += 30;

  p.need(190); // owner summary + proceeds banner never split across pages
  p.h3('4. Owner summary');
  const adj = s.lines.filter((l) => l.type === 'ADJUSTMENT');
  p.kv([['Airbnb net revenue', money(r.netPayoutCents)], ['Less: property expenses', money(-s.expensesCents)], ['Less: management commission', money(-c.commissionCents)],
    ...adj.map((l) => [`Adjustment: ${l.description}`, money(l.amountCents)] as [string, Cell])]);
  p.need(46); p.y += 4;
  doc.roundedRect(L, p.y, W, 38, 5).fill(TEAL);
  p.font(true, 12, '#ffffff'); doc.text('OWNER NET PROCEEDS', L + 14, p.y + 13, { characterSpacing: 0.6, lineBreak: false });
  p.font(true, 18, '#ffffff'); doc.text(formatMoney(s.ownerProceedsCents), L + W - 214, p.y + 10, { width: 200, align: 'right', lineBreak: false });
  p.y += 48;
  if (s.ownerPaidExpensesCents > 0) p.para(`Expenses you paid directly (${formatMoney(s.ownerPaidExpensesCents)}) are shown above for reference and are not deducted.`, { size: 8, color: MUTED });

  p.need(130);
  p.h3(`5. Year to date (${s.year})`);
  p.kv([['YTD gross revenue', money(i.ytd.grossCents)], ['YTD Airbnb fees', money(-i.ytd.platformFeesCents)], ['YTD property expenses', money(-i.ytd.expensesCents)],
    ['YTD management commissions', money(-i.ytd.commissionsCents)]], ['YTD owner proceeds', money(i.ytd.ownerProceedsCents, true)]);

  const earn = s.lines.filter((l) => l.type === 'EARNINGS');
  if (earn.length) {
    p.h3('Airbnb transactions included');
    p.table([{ label: 'Date', w: 90 }, { label: 'Transaction', w: 314 }, { label: 'Net amount', w: 100, align: 'right' }], earn.map((l) => [fmtDate(l.date), l.description.toLowerCase(), money(l.amountCents)]), { size: 8.5 });
  }
  p.need(50); p.y += 10; p.rule();
  p.y += 8; p.para(i.disclaimer, { size: 8, color: MUTED });

  finish(doc, i.statementNumber, !!i.draft);
  return done;
}

export interface AnnualPdfInput { orgName: string; ownerName: string; properties: string[]; report: AnnualReport; preparedOn: string }

export async function renderAnnualPdf(i: AnnualPdfInput, o: { compress?: boolean } = {}): Promise<Buffer> {
  const r = i.report;
  const { doc, page: p, done } = open(`Annual Owner Statement ${r.year}`, i.orgName, i.preparedOn, o.compress ?? true);
  masthead(p, { org: i.orgName, title: `Annual Owner Statement ${r.year}`, subtitle: i.ownerName, right: [`Prepared ${fmtDate(i.preparedOn)}`, `${r.statementCount} monthly statement(s)`, ...(i.properties.length ? [i.properties.join(', ').slice(0, 70)] : [])] });
  p.h3('Summary');
  p.kv([['Annual gross rental revenue', money(r.totals.grossCents)], ['Annual Airbnb/platform fees', money(-r.totals.platformFeesCents)], ['Annual property expenses', money(-r.totals.expensesCents)],
    ['Annual management commissions', money(-r.totals.commissionCents)]], ['Annual owner net proceeds', money(r.totals.ownerProceedsCents, true)]);

  p.h3('Monthly breakdown');
  const cols: Col[] = [{ label: 'Month', w: 66 }, ...['Gross revenue', 'Airbnb fees', 'Net payout', 'Expenses', 'Commission', 'Owner proceeds'].map((label) => ({ label, w: 73, align: 'right' as const }))];
  p.table(cols, r.months.map((m) => [MONTHS[m.month - 1], money(m.grossCents), money(-m.platformFeesCents), money(m.netPayoutCents), money(-m.expensesCents), money(-m.commissionCents), money(m.ownerProceedsCents)]),
    { size: 8, total: ['Total', money(r.totals.grossCents, true), money(-r.totals.platformFeesCents, true), money(r.totals.netPayoutCents, true), money(-r.totals.expensesCents, true), money(-r.totals.commissionCents, true), money(r.totals.ownerProceedsCents, true)] });

  p.h3('Expenses by category');
  if (r.expenseCategories.length === 0) p.para('No property expenses recorded.', { color: MUTED });
  else p.kv(r.expenseCategories.map((c) => [c.category, money(c.cents)] as [string, Cell]), ['Total expenses', money(r.totals.expensesCents, true)]);

  p.h3('How to read this report');
  p.para(r.explanation);
  p.need(50); p.rule(); p.y += 8; p.para(r.disclaimer, { size: 8, color: MUTED });
  finish(doc, `Annual Owner Statement ${r.year} - ${i.ownerName}`, false);
  return done;
}
