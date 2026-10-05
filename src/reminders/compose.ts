import { RECEIPT_THRESHOLD_CENTS } from '../accounting/exceptions.ts';
import { addMonths, monthLabel } from './schedule.ts';

/** Where a month stands. Counts only; produced by repo/reminders.ts from live data at send time. */
export interface MonthEndStatus {
  year: number; month: number;
  periodStatus: 'NONE' | 'DRAFT' | 'REVIEW' | 'FINALIZED' | 'LOCKED';
  activeProperties: number; earningsImported: number; unmatchedTransactions: number;
  propertiesWithoutExpenses: number; missingReceipts: number;
  statements: number; finalizedUnsent: number; failedDeliveries: number;
}
export type ItemState = 'done' | 'todo' | 'warn' | 'later';
export interface ChecklistItem { key: 'import' | 'expenses' | 'finalize' | 'send'; title: string; detail: string; state: ItemState }

const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
export const isComplete = (s: MonthEndStatus) => (s.periodStatus === 'FINALIZED' || s.periodStatus === 'LOCKED') && s.finalizedUnsent === 0 && s.failedDeliveries === 0;

export function checklist(s: MonthEndStatus, monthEnded = true): ChecklistItem[] {
  const label = monthLabel(s.year, s.month).split(' ')[0];
  const finalized = s.periodStatus === 'FINALIZED' || s.periodStatus === 'LOCKED';
  const items: ChecklistItem[] = [];
  items.push(finalized
    ? { key: 'import', state: 'done', title: 'Airbnb earnings imported', detail: `${n(s.earningsImported, 'transaction')} for ${label}, locked with the finalized month${s.unmatchedTransactions > 0 ? ` (${n(s.unmatchedTransactions, 'unmatched transaction')} acknowledged at finalization)` : ''}.` }
    : s.unmatchedTransactions > 0
    ? { key: 'import', state: 'warn', title: 'Match Airbnb transactions', detail: `${n(s.unmatchedTransactions, 'transaction')} not matched to a property. Map the listing, then re-import.` }
    : s.earningsImported === 0
      ? { key: 'import', state: monthEnded ? 'todo' : 'later', title: 'Import Airbnb earnings', detail: monthEnded ? `No Airbnb earnings imported for ${label} yet. Download the CSV from Airbnb and import it.` : `After ${label} ends, download the earnings CSV from Airbnb and import it.` }
      : { key: 'import', state: 'done', title: 'Airbnb earnings imported', detail: `${n(s.earningsImported, 'transaction')} for ${label}.` });
  const expenseNotes = [
    s.propertiesWithoutExpenses > 0 ? `${n(s.propertiesWithoutExpenses, 'property', 'properties')} of ${s.activeProperties} ${s.propertiesWithoutExpenses === 1 ? 'has' : 'have'} no expenses recorded (fine if there were none)` : '',
    s.missingReceipts > 0 ? `${n(s.missingReceipts, 'expense')} of $${RECEIPT_THRESHOLD_CENTS / 100} or more without a receipt` : '',
  ].filter(Boolean);
  items.push(finalized
    ? { key: 'expenses', state: 'done', title: 'Expenses', detail: 'Locked with the finalized month.' }
    : { key: 'expenses', state: s.missingReceipts > 0 ? 'warn' : expenseNotes.length ? 'todo' : 'done', title: 'Enter expenses and receipts', detail: expenseNotes.length ? `${expenseNotes.join('; ')}.` : 'Every property has expenses recorded and receipts attached.' });
  items.push(finalized
    ? { key: 'finalize', state: 'done', title: 'Statements finalized', detail: `${n(s.statements, 'statement')} finalized and locked.` }
    : s.periodStatus === 'REVIEW'
      ? { key: 'finalize', state: monthEnded ? 'todo' : 'later', title: 'Review and finalize', detail: `${n(s.statements, 'draft statement')} ready for review. Check the exceptions, then finalize.` }
      : { key: 'finalize', state: monthEnded ? 'todo' : 'later', title: 'Generate and review statements', detail: 'Statements have not been generated yet. Open the monthly close to generate drafts.' });
  items.push(!finalized
    ? { key: 'send', state: 'later', title: 'Send statements to owners', detail: 'After finalizing.' }
    : s.failedDeliveries > 0
      ? { key: 'send', state: 'warn', title: 'Fix failed deliveries', detail: `${n(s.failedDeliveries, 'message')} to owners failed. See Communications and resend.` }
      : s.finalizedUnsent > 0
        ? { key: 'send', state: 'todo', title: 'Send statements to owners', detail: `${n(s.finalizedUnsent, 'finalized statement')} not sent yet.` }
        : { key: 'send', state: 'done', title: 'Statements sent', detail: 'Every owner has been sent their statement.' });
  return items;
}

export interface ReminderInput {
  orgName: string; status: MonthEndStatus; offset: number;
  /** Local calendar date (YYYY-MM-DD) the reminder goes out on, in the organization's time zone. */
  sendDate: string; dueDay: number | null; closeUrl: string; test?: boolean;
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const MARK: Record<ItemState, string> = { done: '[x]', todo: '[ ]', warn: '[!]', later: '[-]' };
const COLOR: Record<ItemState, string> = { done: '#15803d', todo: '#0f172a', warn: '#b45309', later: '#64748b' };
const ICON: Record<ItemState, string> = { done: '&#10003;', todo: '&#9675;', warn: '!', later: '&#8211;' };

export function composeReminder(r: ReminderInput): { subject: string; text: string; html: string; openItems: number } {
  const { status: s } = r;
  const label = monthLabel(s.year, s.month);
  const lastDay = `${s.year}-${String(s.month).padStart(2, '0')}-${String(new Date(Date.UTC(s.year, s.month, 0)).getUTCDate()).padStart(2, '0')}`;
  const daysToEnd = dayDiff(r.sendDate, lastDay);
  const monthEnded = daysToEnd < 0;
  const items = checklist(s, monthEnded);
  const open = items.filter((i) => i.state === 'todo' || i.state === 'warn').length;
  const next = addMonths(s.year, s.month, 1);
  const due = r.dueDay ? `${next.year}-${String(next.month).padStart(2, '0')}-${String(r.dueDay).padStart(2, '0')}` : null;
  const dueLabel = due ? `${MON[next.month - 1]} ${r.dueDay}` : '';
  const toDue = due ? dayDiff(r.sendDate, due) : null;

  let intro: string, subject: string;
  if (!monthEnded) {
    const when = daysToEnd === 0 ? 'today' : daysToEnd === 1 ? 'tomorrow' : `in ${daysToEnd} days`;
    subject = `${label} ends ${when}: month-end checklist`;
    intro = `${label} ends ${when}. Getting expenses and receipts in now makes the close quicker.`;
  } else if (isComplete(s)) {
    subject = `${label} close is complete`;
    intro = `${label} is finalized and every statement has been sent. Nothing to do.`;
  } else {
    subject = `${label} close: ${n(open, 'item')} open`;
    intro = `${label} has ended. Here is where the close stands.`;
  }
  if (due && toDue !== null && monthEnded && !isComplete(s)) {
    const dueText = toDue > 1 ? `due by ${dueLabel} (in ${toDue} days)` : toDue === 1 ? `due tomorrow, ${dueLabel}` : toDue === 0 ? `due today, ${dueLabel}` : `overdue: they were due on ${dueLabel}`;
    intro += ` Owner statements are ${dueText}.`;
    subject += toDue < 0 ? ' (overdue)' : ` (due ${dueLabel})`;
  }
  if (r.test) subject = `[Test] ${subject}`;

  const text = [
    `${r.orgName}: month-end close for ${label}`, '', intro, '',
    ...items.map((i) => `${MARK[i.state]} ${i.title}: ${i.detail}`), '',
    `Open the monthly close: ${r.closeUrl}`, '',
    'Nothing is finalized or sent automatically; these reminders only report what is outstanding.',
    'You get these because month-end reminders are on for your role. Turn them off for yourself under Settings → Your account.',
  ].join('\n');

  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f7fa;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a">
<table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px"><tr><td style="padding:24px">
<div style="font-size:13px;color:#64748b">${esc(r.orgName)}</div>
<h1 style="font-size:20px;margin:4px 0 12px">Month-end close: ${esc(label)}</h1>
<p style="margin:0 0 16px;line-height:1.5">${esc(intro)}</p>
<table role="presentation" width="100%" style="border-collapse:collapse">${items.map((i) => `<tr><td style="width:28px;vertical-align:top;padding:8px 0;color:${COLOR[i.state]};font-weight:700">${ICON[i.state]}</td><td style="padding:8px 0;border-bottom:1px solid #f1f5f9"><div style="font-weight:600;color:${COLOR[i.state]}">${esc(i.title)}</div><div style="font-size:14px;color:#475569;line-height:1.4">${esc(i.detail)}</div></td></tr>`).join('')}</table>
<p style="margin:20px 0"><a href="${esc(r.closeUrl)}" style="display:inline-block;background:#0f766e;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600">Open the monthly close</a></p>
<p style="font-size:12px;color:#64748b;line-height:1.5;margin:0">Nothing is finalized or sent automatically; these reminders only report what is outstanding. You get these because month-end reminders are on for your role. Turn them off for yourself under Settings → Your account.</p>
</td></tr></table></body></html>`;
  return { subject, text, html, openItems: open };
}
