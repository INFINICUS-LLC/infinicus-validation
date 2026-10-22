/**
 * Business Intelligence sales report (BI-SALES-1): a governed, READ-ONLY, descriptive report over authoritative Business Operations orders.
 *
 *  - BI reads Business Operations only through the structural {@link SalesFactsPort} (joined at the API composition root, so this package never imports
 *    Business Operations) and persists NOTHING: the report is computed on read from the one source of truth, so there is no second copy that can drift.
 *  - Periods are explicit and bounded: an inclusive range of calendar days [from, to] on the order's recorded date, at most {@link MAX_REPORT_DAYS} days.
 *  - Currency is explicit and never mixed: every figure belongs to one currency (code and minor-unit exponent), amounts are integer minor units, and a
 *    business that sold in two currencies in the period gets two separate sections. Nothing is converted or summed across currencies.
 *  - It never fabricates: no orders in the period means no currency sections at all; days without orders inside a section are reported as zeros so the
 *    series is continuous. An average is only stated when there is at least one sale, and its rounding rule is part of the contract (half up).
 *  - Each currency section states whether it reconciles (gross - discounts = net). A mismatch is reported, never hidden or adjusted.
 */
import type { TenantContext } from '@infinicus/database';

export const MAX_REPORT_DAYS = 366;
export const SALES_REPORT_BASIS = 'order_date' as const;

export interface SalesDayFactsView {
  date: string;
  currencyCode: string;
  currencyExponent: number;
  completedOrders: number;
  voidedOrders: number;
  openOrders: number;
  otherStatusOrders: number;
  grossMinor: number;
  discountMinor: number;
  netMinor: number;
}
export type SalesFactsResultView =
  | { outcome: 'FACTS'; facts: SalesDayFactsView[] }
  | { outcome: 'UNAVAILABLE'; code: string; detail: string };
export interface SalesFactsPort {
  load(ctx: TenantContext, request: { businessId: string; from: string; to: string }): Promise<SalesFactsResultView>;
}

export interface SalesDaySeriesPoint {
  date: string;
  completedOrders: number;
  voidedOrders: number;
  openOrders: number;
  otherStatusOrders: number;
  grossMinor: number;
  discountMinor: number;
  netMinor: number;
}
export interface SalesCurrencySection {
  currency: { code: string; minorUnitExponent: number };
  totals: Omit<SalesDaySeriesPoint, 'date'> & {
    /** Net per completed order in minor units, rounded half up; null when there is no completed order. */
    averageOrderNetMinor: number | null;
    /** gross - discounts = net over the whole section. */
    reconciles: boolean;
  };
  daily: SalesDaySeriesPoint[];
}
export interface SalesReport {
  businessId: string;
  period: { from: string; to: string; days: number; basis: typeof SALES_REPORT_BASIS; inclusive: true };
  source: { layer: 'BO'; definition: 'completed orders; net = order total; gross = non-discount lines; discounts = discount lines' };
  currencies: SalesCurrencySection[];
}
export type SalesReportResult =
  | { outcome: 'REPORT'; report: SalesReport }
  | { outcome: 'NOT_AVAILABLE'; code: string; detail: string };

/** A refused request. The API maps this name to 400. */
export class SalesReportPeriodError extends Error {
  constructor(reason: string) {
    super(`Sales report period invalid: ${reason}`);
    this.name = 'ValidationError';
  }
}

const DAY_MS = 86_400_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parse a strict YYYY-MM-DD calendar date to a UTC day number; null when malformed or not a real date. */
function dayNumber(date: string): number | null {
  const m = DATE_RE.exec(date);
  if (m === null) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return ms / DAY_MS;
}
const dateOf = (day: number): string => new Date(day * DAY_MS).toISOString().slice(0, 10);

/** Net per sale in minor units, rounded half up (exact integer arithmetic). */
export function averageHalfUp(netMinor: number, orders: number): number | null {
  if (orders <= 0) return null;
  return Math.floor((2 * netMinor + orders) / (2 * orders));
}

export function validateSalesPeriod(from: string, to: string): { fromDay: number; toDay: number; days: number } {
  const fromDay = dayNumber(from);
  const toDay = dayNumber(to);
  if (fromDay === null) throw new SalesReportPeriodError('from must be a real calendar date in YYYY-MM-DD form');
  if (toDay === null) throw new SalesReportPeriodError('to must be a real calendar date in YYYY-MM-DD form');
  if (toDay < fromDay) throw new SalesReportPeriodError('to must not be before from');
  const days = toDay - fromDay + 1;
  if (days > MAX_REPORT_DAYS) throw new SalesReportPeriodError(`the period may span at most ${MAX_REPORT_DAYS} days`);
  return { fromDay, toDay, days };
}

const zeroPoint = (date: string): SalesDaySeriesPoint => ({ date, completedOrders: 0, voidedOrders: 0, openOrders: 0, otherStatusOrders: 0, grossMinor: 0, discountMinor: 0, netMinor: 0 });

export class SalesReportService {
  constructor(private readonly facts: SalesFactsPort) {}

  async report(ctx: TenantContext, request: { businessId: string; from: string; to: string }): Promise<SalesReportResult> {
    const { fromDay, toDay, days } = validateSalesPeriod(request.from, request.to);
    const loaded = await this.facts.load(ctx, request);
    if (loaded.outcome === 'UNAVAILABLE') return { outcome: 'NOT_AVAILABLE', code: loaded.code, detail: loaded.detail };

    const byCurrency = new Map<string, { exponent: number; byDate: Map<string, SalesDaySeriesPoint> }>();
    for (const f of loaded.facts) {
      const section = byCurrency.get(f.currencyCode) ?? { exponent: f.currencyExponent, byDate: new Map<string, SalesDaySeriesPoint>() };
      if (section.exponent !== f.currencyExponent) {
        return { outcome: 'NOT_AVAILABLE', code: 'CURRENCY_EXPONENT_CONFLICT', detail: `currency ${f.currencyCode} was reported with two different minor-unit exponents` };
      }
      const point = section.byDate.get(f.date) ?? zeroPoint(f.date);
      point.completedOrders += f.completedOrders; point.voidedOrders += f.voidedOrders; point.openOrders += f.openOrders; point.otherStatusOrders += f.otherStatusOrders;
      point.grossMinor += f.grossMinor; point.discountMinor += f.discountMinor; point.netMinor += f.netMinor;
      section.byDate.set(f.date, point);
      byCurrency.set(f.currencyCode, section);
    }

    const currencies: SalesCurrencySection[] = [...byCurrency.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([code, section]) => {
      const daily: SalesDaySeriesPoint[] = [];
      for (let day = fromDay; day <= toDay; day++) {
        const date = dateOf(day);
        daily.push(section.byDate.get(date) ?? zeroPoint(date));
      }
      const totals = daily.reduce((t, p) => ({
        completedOrders: t.completedOrders + p.completedOrders, voidedOrders: t.voidedOrders + p.voidedOrders, openOrders: t.openOrders + p.openOrders,
        otherStatusOrders: t.otherStatusOrders + p.otherStatusOrders, grossMinor: t.grossMinor + p.grossMinor, discountMinor: t.discountMinor + p.discountMinor,
        netMinor: t.netMinor + p.netMinor,
      }), { completedOrders: 0, voidedOrders: 0, openOrders: 0, otherStatusOrders: 0, grossMinor: 0, discountMinor: 0, netMinor: 0 });
      return {
        currency: { code, minorUnitExponent: section.exponent },
        totals: { ...totals, averageOrderNetMinor: averageHalfUp(totals.netMinor, totals.completedOrders), reconciles: totals.grossMinor - totals.discountMinor === totals.netMinor },
        daily,
      };
    });

    return {
      outcome: 'REPORT',
      report: {
        businessId: request.businessId,
        period: { from: request.from, to: request.to, days, basis: SALES_REPORT_BASIS, inclusive: true },
        source: { layer: 'BO', definition: 'completed orders; net = order total; gross = non-discount lines; discounts = discount lines' },
        currencies,
      },
    };
  }
}
