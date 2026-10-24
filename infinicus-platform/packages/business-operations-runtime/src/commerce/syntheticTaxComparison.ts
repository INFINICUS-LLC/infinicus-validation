import {
  HarnessInputError, addRational, divideRational, minorInteger, multiplyRational, quantityRational,
  rational, roundRational, validateHarnessCurrency, type HarnessRoundingMode, type Rational,
} from './exactMoneyHarness.js';

export const SYNTHETIC_TAX_HARNESS_AUTHORITATIVE = false as const;
export type AllocationMode = 'LINE_SPECIFIC' | 'PROPORTIONAL_LARGEST_REMAINDER';
export type RoundingStage = 'PER_LINE_PER_RATE' | 'AGGREGATE_PER_RATE';
export type SyntheticTaxClass = 'TAXABLE' | 'ZERO_RATED' | 'EXEMPT';
export type SyntheticTreatment = 'INCLUSIVE' | 'EXCLUSIVE';
export interface DiscountLine { id: string; eligible: boolean; capacityMinor: string }
export interface DiscountRequest {
  mode: AllocationMode;
  amountMinor: string;
  explicit?: readonly { lineId: string; amountMinor: string }[];
}
export interface SyntheticLine {
  id: string;
  quantity: string;
  uomMaxFractionDigits: number;
  unitPriceMinor: string;
  discountEligible: boolean;
  taxClass: SyntheticTaxClass;
  priceTreatment: SyntheticTreatment;
  rate: { id: string; numerator: string; denominator: string } | null;
}
export interface SyntheticBasket {
  currencyCode: string;
  currencyExponent: number;
  lines: readonly SyntheticLine[];
  discount: DiscountRequest;
  rounding: { stage: RoundingStage; mode: HarnessRoundingMode };
}
export interface SyntheticBasketResult {
  readonly illustrative: true;
  readonly authoritative: false;
  readonly taxPolicyActivated: false;
  readonly currencyCode: string;
  readonly subtotalMinor: string;
  readonly discountMinor: string;
  readonly includedTaxMinor: string;
  readonly exclusiveTaxMinor: string;
  readonly payableMinor: string;
  readonly lines: readonly { id: string; taxClass: SyntheticTaxClass; priceTreatment: SyntheticTreatment;
    displayedMinor: string; discountMinor: string; discountedDisplayedMinor: string; exactTax: string;
    roundedTaxMinor: string | null }[];
  readonly taxGroups: readonly { rateId: string; treatment: SyntheticTreatment; taxMinor: string }[];
}

const checked = (value: bigint) => minorInteger(value.toString());
const sum = (values: readonly bigint[]) => values.reduce((total, value) => checked(total + value), 0n);
const positive = (value: string): bigint => {
  const parsed = minorInteger(value);
  if (parsed < 0n) throw new HarnessInputError('discount and capacity must be nonnegative');
  return parsed;
};
const ordered = <T extends { id: string }>(values: readonly T[]): T[] => [...values].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const unique = (values: readonly { id: string }[]) => {
  if (values.some((value) => !value.id) || new Set(values.map((value) => value.id)).size !== values.length)
    throw new HarnessInputError('line IDs must be nonempty and unique');
};

/** Compare proposed allocation methods. Output is sorted by stable line ID. */
export function allocateSyntheticDiscount(lines: readonly DiscountLine[], request: DiscountRequest): readonly { lineId: string; amountMinor: string }[] {
  unique(lines);
  const amount = positive(request.amountMinor);
  const capacities = new Map(ordered(lines).map((line) => [line.id, positive(line.capacityMinor)]));
  const eligible = ordered(lines.filter((line) => line.eligible && capacities.get(line.id)! > 0n));
  const totalEligible = sum(eligible.map((line) => capacities.get(line.id)!));
  if (amount > totalEligible) throw new HarnessInputError('discount exceeds eligible amount');
  const allocated = new Map(lines.map((line) => [line.id, 0n]));
  if (request.mode === 'LINE_SPECIFIC') {
    if (!request.explicit) throw new HarnessInputError('line-specific allocation requires explicit entries');
    const seen = new Set<string>();
    for (const entry of request.explicit) {
      if (seen.has(entry.lineId) || !capacities.has(entry.lineId)) throw new HarnessInputError('duplicate or unknown discount line');
      seen.add(entry.lineId);
      const value = positive(entry.amountMinor);
      if (value > 0n && !lines.find((line) => line.id === entry.lineId)?.eligible)
        throw new HarnessInputError('discount line is ineligible');
      if (value > capacities.get(entry.lineId)!) throw new HarnessInputError('discount exceeds line capacity');
      allocated.set(entry.lineId, value);
    }
  } else if (request.mode === 'PROPORTIONAL_LARGEST_REMAINDER') {
    if (request.explicit) throw new HarnessInputError('proportional allocation cannot take explicit entries');
    if (amount > 0n) {
      const quotas = eligible.map((line) => {
        const product = amount * capacities.get(line.id)!;
        return { id: line.id, floor: product / totalEligible, remainder: product % totalEligible };
      });
      for (const quota of quotas) allocated.set(quota.id, quota.floor);
      let residual = amount - sum(quotas.map((quota) => quota.floor));
      quotas.sort((a, b) => a.remainder === b.remainder ? (a.id < b.id ? -1 : 1) : a.remainder > b.remainder ? -1 : 1);
      for (const quota of quotas) {
        if (residual === 0n) break;
        allocated.set(quota.id, allocated.get(quota.id)! + 1n);
        residual -= 1n;
      }
      if (residual !== 0n) throw new HarnessInputError('residual allocation failed');
    }
  } else throw new HarnessInputError('unknown discount allocation mode');
  if (sum([...allocated.values()]) !== amount) throw new HarnessInputError('discount allocation does not conserve amount');
  for (const [id, value] of allocated) if (value > capacities.get(id)!) throw new HarnessInputError('discount exceeds line capacity');
  return ordered(lines).map((line) => ({ lineId: line.id, amountMinor: allocated.get(line.id)!.toString() }));
}

const formatRational = (value: Rational) => `${value.numerator}/${value.denominator}`;
const taxRate = (line: SyntheticLine): Rational | null => {
  if (!['TAXABLE', 'ZERO_RATED', 'EXEMPT'].includes(line.taxClass)) throw new HarnessInputError('unknown tax classification');
  if (!['INCLUSIVE', 'EXCLUSIVE'].includes(line.priceTreatment)) throw new HarnessInputError('unknown price treatment');
  if (line.taxClass !== 'TAXABLE') {
    if (line.rate !== null) throw new HarnessInputError('exempt or zero-rated line cannot carry a taxable rate');
    return null;
  }
  if (!line.rate?.id) throw new HarnessInputError('taxable line needs an explicit synthetic rate');
  const numerator = minorInteger(line.rate.numerator);
  const denominator = minorInteger(line.rate.denominator);
  if (numerator <= 0n || denominator <= 0n) throw new HarnessInputError('synthetic rate must be positive');
  return rational(numerator, denominator);
};

/** Illustrative tax arithmetic. No policy lookup, permission, order writer or legal determination. */
export function compareSyntheticTaxBasket(input: SyntheticBasket): SyntheticBasketResult {
  validateHarnessCurrency(input.currencyCode, input.currencyExponent);
  if (!['PER_LINE_PER_RATE', 'AGGREGATE_PER_RATE'].includes(input.rounding.stage)) throw new HarnessInputError('unknown rounding stage');
  unique(input.lines);
  if (input.lines.length === 0) throw new HarnessInputError('basket requires a line');
  const lines = ordered(input.lines).map((line) => {
    const unit = minorInteger(line.unitPriceMinor);
    if (unit < 0n) throw new HarnessInputError('sale line price must be nonnegative; use signed arithmetic for adjustments');
    const quantity = quantityRational(line.quantity, line.uomMaxFractionDigits);
    const displayed = roundRational(multiplyRational(rational(unit, 1n), quantity), input.rounding.mode);
    return { line, displayed, rate: taxRate(line) };
  });
  const allocations = allocateSyntheticDiscount(lines.map(({ line, displayed }) => ({
    id: line.id, eligible: line.discountEligible, capacityMinor: displayed.toString(),
  })), input.discount);
  const discounts = new Map(allocations.map((row) => [row.lineId, minorInteger(row.amountMinor)]));
  const groups = new Map<string, { rateId: string; treatment: SyntheticTreatment; exact: Rational; rounded: bigint }>();
  const rateDefinitions = new Map<string, string>();
  const resultLines = lines.map(({ line, displayed, rate }) => {
    const discount = discounts.get(line.id)!;
    const net = checked(displayed - discount);
    const exactTax = rate === null ? rational(0n, 1n) : line.priceTreatment === 'INCLUSIVE'
      ? multiplyRational(rational(net, 1n), divideRational(rate, addRational(rational(1n, 1n), rate)))
      : multiplyRational(rational(net, 1n), rate);
    let roundedTax: bigint | null = null;
    if (rate !== null) {
      const definition = formatRational(rate);
      const prior = rateDefinitions.get(line.rate!.id);
      if (prior && prior !== definition) throw new HarnessInputError('one rate ID has conflicting fractions');
      rateDefinitions.set(line.rate!.id, definition);
      const key = `${line.rate!.id}\u0000${line.priceTreatment}`;
      const group = groups.get(key) ?? { rateId: line.rate!.id, treatment: line.priceTreatment, exact: rational(0n, 1n), rounded: 0n };
      group.exact = addRational(group.exact, exactTax);
      if (input.rounding.stage === 'PER_LINE_PER_RATE') {
        roundedTax = roundRational(exactTax, input.rounding.mode);
        group.rounded = checked(group.rounded + roundedTax);
      }
      groups.set(key, group);
    }
    return { id: line.id, taxClass: line.taxClass, priceTreatment: line.priceTreatment,
      displayedMinor: displayed.toString(), discountMinor: discount.toString(), discountedDisplayedMinor: net.toString(),
      exactTax: formatRational(exactTax), roundedTaxMinor: roundedTax?.toString() ?? null };
  });
  if (input.rounding.stage === 'AGGREGATE_PER_RATE')
    for (const group of groups.values()) group.rounded = roundRational(group.exact, input.rounding.mode);
  const taxGroups = [...groups.values()].sort((a, b) => {
    const left = `${a.rateId}\u0000${a.treatment}`;
    const right = `${b.rateId}\u0000${b.treatment}`;
    return left < right ? -1 : left > right ? 1 : 0;
  })
    .map((group) => ({ rateId: group.rateId, treatment: group.treatment, taxMinor: group.rounded.toString() }));
  const subtotal = sum(lines.map((line) => line.displayed));
  const totalDiscount = sum([...discounts.values()]);
  const included = sum([...groups.values()].filter((group) => group.treatment === 'INCLUSIVE').map((group) => group.rounded));
  const exclusive = sum([...groups.values()].filter((group) => group.treatment === 'EXCLUSIVE').map((group) => group.rounded));
  const payable = checked(subtotal - totalDiscount + exclusive);
  if (sum(resultLines.map((line) => minorInteger(line.discountMinor))) !== totalDiscount ||
      sum(resultLines.map((line) => minorInteger(line.discountedDisplayedMinor))) !== subtotal - totalDiscount)
    throw new HarnessInputError('basket reconciliation failed');
  return { illustrative: true, authoritative: false, taxPolicyActivated: false, currencyCode: input.currencyCode,
    subtotalMinor: subtotal.toString(), discountMinor: totalDiscount.toString(), includedTaxMinor: included.toString(),
    exclusiveTaxMinor: exclusive.toString(), payableMinor: payable.toString(), lines: resultLines, taxGroups };
}
