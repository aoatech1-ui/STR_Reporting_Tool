import { formatMoney, formatRate, mulBps, type Cents } from '../money.ts';

export type CommissionType = 'PERCENT_GROSS' | 'PERCENT_NET' | 'FIXED' | 'HYBRID';

/** Per-property commission + statement policy. Dated so history never changes when a rule is edited. */
export interface CommissionRule {
  id: string;
  type: CommissionType;
  rateBps: number;                 // 2000 = 20%
  fixedCents: number;
  includeCleaningFees: boolean;    // does commission apply to cleaning fees?
  excludeTaxes: boolean;
  hybridBasis: 'GROSS' | 'NET';    // basis of the % leg of HYBRID
  effectiveFrom: string;           // YYYY-MM-DD
  effectiveTo: string | null;
}

export interface RevenueTotals {
  grossBookingCents: Cents; cleaningFeeCents: Cents; otherRevenueCents: Cents;
  platformFeeCents: Cents; taxCents: Cents; adjustmentCents: Cents; refundCents: Cents;
  coHostPayoutCents: Cents; netPayoutCents: Cents;
}

export interface CommissionCalculation {
  rule: CommissionRule;            // full snapshot, stored with the calculation
  calculationBasis: string;
  baseCents: Cents;
  rateBps: number;
  fixedCents: number;
  commissionCents: Cents;
  explanation: string;             // e.g. "20% × $6,000.00 = $1,200.00"
}

/** Picks the single rule effective for the period end. Zero or overlapping rules are errors, never guessed. */
export function selectRule(rules: CommissionRule[], periodEnd: string): CommissionRule {
  const hits = rules.filter((r) => r.effectiveFrom <= periodEnd && (r.effectiveTo === null || r.effectiveTo >= periodEnd));
  if (hits.length === 0) throw new Error(`No commission rule effective on ${periodEnd}`);
  if (hits.length > 1) throw new Error(`Overlapping commission rules effective on ${periodEnd}`);
  return hits[0];
}

function percentBase(t: RevenueTotals, rule: CommissionRule, basis: 'GROSS' | 'NET'): { base: Cents; label: string } {
  if (basis === 'GROSS') {
    // booking revenue (+ cleaning if agreed) net of refunds; before Airbnb fees
    const base = t.grossBookingCents + t.otherRevenueCents + t.refundCents + (rule.includeCleaningFees ? t.cleaningFeeCents : 0)
      + (rule.excludeTaxes ? 0 : t.taxCents);
    return { base, label: `gross booking revenue${rule.includeCleaningFees ? ' incl. cleaning' : ''}` };
  }
  const base = t.netPayoutCents - (rule.includeCleaningFees ? 0 : t.cleaningFeeCents) - (rule.excludeTaxes ? t.taxCents : 0);
  return { base, label: `Airbnb net payout${rule.includeCleaningFees ? '' : ' excl. cleaning'}` };
}

export function calculateCommission(t: RevenueTotals, rule: CommissionRule): CommissionCalculation {
  const pct = (basis: 'GROSS' | 'NET') => {
    const { base, label } = percentBase(t, rule, basis);
    const amt = Math.max(0, mulBps(base, rule.rateBps)); // no negative commission on a net-negative month
    return { base, label, amt, text: `${formatRate(rule.rateBps)} × ${formatMoney(base)} = ${formatMoney(amt)}` };
  };
  switch (rule.type) {
    case 'FIXED':
      return { rule, calculationBasis: 'Fixed monthly amount', baseCents: 0, rateBps: 0, fixedCents: rule.fixedCents,
        commissionCents: rule.fixedCents, explanation: `Fixed fee = ${formatMoney(rule.fixedCents)}` };
    case 'PERCENT_GROSS':
    case 'PERCENT_NET': {
      const p = pct(rule.type === 'PERCENT_GROSS' ? 'GROSS' : 'NET');
      return { rule, calculationBasis: p.label, baseCents: p.base, rateBps: rule.rateBps, fixedCents: 0,
        commissionCents: p.amt, explanation: p.text };
    }
    case 'HYBRID': {
      const p = pct(rule.hybridBasis);
      const total = p.amt + rule.fixedCents;
      return { rule, calculationBasis: `${p.label} + fixed`, baseCents: p.base, rateBps: rule.rateBps, fixedCents: rule.fixedCents,
        commissionCents: total, explanation: `${p.text} + ${formatMoney(rule.fixedCents)} fixed = ${formatMoney(total)}` };
    }
  }
}
