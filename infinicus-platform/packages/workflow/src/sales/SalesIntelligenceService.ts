/**
 * Business Intelligence sales and operations performance service (NEW-BI-02). It owns the DERIVED figures; Business Operations owns the order records it
 * reads. BI reaches Business Operations only through the structural `SalesFactsPort` (joined at the API composition root), so this package imports no
 * Business Operations code, and it never writes: reports are computed on request and are not persisted (no second copy to drift).
 */
import type { TenantContext } from '@infinicus/database';
import { validateSalesReport, type SalesFacts, type SalesReport, type TrendGranularity } from '@infinicus/handoff-contracts';
import { MAX_REPORT_DAYS, MAX_TREND_BUCKETS } from '../financial/FinancialIntelligenceService.js';
import { buckets, isRealDate, previousRange, rangeDays } from '../financial/periods.js';
import { buildSalesReport, DEFAULT_TOP_PRODUCTS, MAX_TOP_PRODUCTS } from './salesReport.js';

export interface SalesFactsRequest { businessId: string; from: string; to: string }
export type SalesFactsPortResult =
  | { outcome: 'FACTS'; facts: SalesFacts }
  | { outcome: 'UNAVAILABLE'; code: string; detail: string };
export interface SalesFactsPort { load(ctx: TenantContext, request: SalesFactsRequest): Promise<SalesFactsPortResult> }

export interface SalesReportRequest {
  businessId: string;
  from: string;
  to: string;
  granularity: TrendGranularity;
  /** `previous` compares with the immediately preceding period of equal length; `none` omits the comparison. */
  compare: 'previous' | 'none';
  /** Products ranked per currency; defaults to DEFAULT_TOP_PRODUCTS. */
  topProducts?: number;
}

export type SalesReportOutcome =
  | { outcome: 'REPORT'; report: SalesReport }
  | { outcome: 'UNAVAILABLE'; code: 'INVALID_REQUEST' | 'FACTS_UNAVAILABLE' | 'REPORT_INVALID'; detail: string };

export class SalesIntelligenceService {
  constructor(private readonly deps: { facts: SalesFactsPort }) {}

  async report(ctx: TenantContext, request: SalesReportRequest): Promise<SalesReportOutcome> {
    const invalid = (detail: string): SalesReportOutcome => ({ outcome: 'UNAVAILABLE', code: 'INVALID_REQUEST', detail });
    if (!isRealDate(request.from) || !isRealDate(request.to)) return invalid('from and to must be real YYYY-MM-DD dates');
    if (request.from > request.to) return invalid('from must not be after to');
    const range = { from: request.from, to: request.to };
    if (rangeDays(range) > MAX_REPORT_DAYS) return invalid(`the period must not exceed ${MAX_REPORT_DAYS} days`);
    if (buckets(range, request.granularity).length > MAX_TREND_BUCKETS) return invalid(`the trend must not exceed ${MAX_TREND_BUCKETS} buckets`);
    const topProducts = request.topProducts ?? DEFAULT_TOP_PRODUCTS;
    if (!Number.isInteger(topProducts) || topProducts < 1 || topProducts > MAX_TOP_PRODUCTS) return invalid(`topProducts must be an integer from 1 to ${MAX_TOP_PRODUCTS}`);

    const current = await this.deps.facts.load(ctx, { businessId: request.businessId, ...range });
    if (current.outcome !== 'FACTS') return { outcome: 'UNAVAILABLE', code: 'FACTS_UNAVAILABLE', detail: current.detail };
    let previous: SalesFacts | null = null;
    if (request.compare === 'previous') {
      const loaded = await this.deps.facts.load(ctx, { businessId: request.businessId, ...previousRange(range) });
      if (loaded.outcome !== 'FACTS') return { outcome: 'UNAVAILABLE', code: 'FACTS_UNAVAILABLE', detail: loaded.detail };
      previous = loaded.facts;
    }
    const report = buildSalesReport({ current: current.facts, previous, granularity: request.granularity, topProducts });
    const check = validateSalesReport(report);
    if (!check.valid) return { outcome: 'UNAVAILABLE', code: 'REPORT_INVALID', detail: check.reasons.join(',') };
    return { outcome: 'REPORT', report };
  }
}
