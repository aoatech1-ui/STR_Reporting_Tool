# Recurring expenses

For expenses that repeat: utilities, insurance, HOA dues, internet, software, pest control contracts.
A recurring expense is a template. Each time it comes due it posts an **ordinary expense** into that month, so it shows up in the
expense list, on the statement and in the audit log exactly like one entered by hand.

## Set up

**Recurring expenses** in the sidebar (or the button on Expenses) → *Add recurring expense*:

* Property, vendor, category, amount, sales tax, owner-paid / reimbursable, description and notes, as for any expense.
* **Repeats**: monthly, every 2 months, quarterly, twice a year or yearly.
* **On day**: 1st to 31st. A day past the month's end uses its last day (the 31st in February posts on the 28th or 29th).
* **First month** and optional **last month**. A first month in the past (up to 12 months) posts the occurrences already due in open months as soon as you save.

## When it posts

* **On its day**, by the worker (checked every minute), using the organization's date. The time zone is the one chosen under Month-end reminders (UTC if never set).
* **When a month is reviewed or finalized**, every recurring expense for that month is posted first, even if its day has not come yet. A closed month always contains its recurring expenses, even if the worker was down.
* *Post due now* on the Recurring expenses page does what the worker does, immediately.
* **Exactly once.** Each recurring expense and month is recorded once (unique), however many workers run or how often a month is reviewed.
* **Finalized months are never changed.** If an occurrence comes due for a month that is already finalized, it is recorded as *Skipped* with the reason. Add it in an open month as an adjustment if it belongs there.

## Changing things

| You want to… | Do this |
|---|---|
| Change the amount from now on | Edit the recurring expense. Only months not yet posted change. |
| Change one month's amount (a higher bill) | Edit that posted expense. |
| Not post next month | *Skip* it under Upcoming (*Undo skip* to reverse). |
| Remove a month that was already posted | Delete that expense (while the month is open). It is not posted again. |
| End it | *Stop* (or set a last month). Posted expenses stay. *Resume* restarts it. |
| Delete it entirely | Only possible while nothing was ever posted from it. |

Automatic postings appear in the audit log as made by the system (`EXPENSE_CREATED`, `RECURRING_EXPENSE_POSTED`), manual ones under the person's name.
Template changes are audited too (`RECURRING_EXPENSE_CREATED/UPDATED/STOPPED/RESUMED/SKIPPED/UNSKIPPED/DELETED`).

Receipts: attach them to the posted expense each month as usual; recurring expenses of $75 or more without a receipt are flagged like any other.
