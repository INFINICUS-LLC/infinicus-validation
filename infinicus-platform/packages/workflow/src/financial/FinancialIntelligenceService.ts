/**
 * Business Intelligence financial reporting service (NEW-BI-01). It owns the DERIVED analytical figures; Business Operations owns the operational records it
 * reads. BI reaches Business Operations only through the structural `FinancialFactsPort` (joined at the API composition root), so this package imports no
 * Business Operations code, and it never writes: reports are computed on request from read-only facts and are not persisted (no second copy to drift).
 */
import type { TenantContext } from '@infinicus/database';
import { validateFinancialReport, type FinancialFacts, type FinancialReport, type TrendGranularity } from '@infinicus/handoff-contracts';
import { buildFinancialReport } from './financialReport.js';
import { buckets, isRealDate, previousRange, rangeDays } from './periods.js';

export const MAX_REPORT_DAYS = 366;
export const MAX_TREND_BUCKETS = 400;

export interface FinancialFactsRequest { businessId: string; from: string; to: string }
export type FinancialFactsPortResult =
  | { outcome: 'FACTS'; facts: FinancialFacts }
  | { outcome: 'UNAVAILABLE'; code: string; detail: string };
export interface FinancialFactsPort { load(ctx: TenantContext, request: FinancialFactsRequest): Promise<FinancialFactsPortResult> }

export interface FinancialReportRequest {
  businessId: string;
  from: string;
  to: string;
  granularity: TrendGranularity;
  /** `previous` compares with the immediately preceding period of equal length; `none` omits the comparison. */
  compare: 'previous' | 'none';
}

export type FinancialReportOutcome =
  | { outcome: 'REPORT'; report: FinancialReport }
  | { outcome: 'UNAVAILABLE'; code: 'INVALID_REQUEST' | 'FACTS_UNAVAILABLE' | 'REPORT_INVALID'; detail: string };

export class FinancialIntelligenceService {
  constructor(private readonly deps: { facts: FinancialFactsPort }) {}

  async report(ctx: TenantContext, request: FinancialReportRequest): Promise<FinancialReportOutcome> {
    const invalid = (detail: string): FinancialReportOutcome => ({ outcome: 'UNAVAILABLE', code: 'INVALID_REQUEST', detail });
    if (!isRealDate(request.from) || !isRealDate(request.to)) return invalid('from and to must be real YYYY-MM-DD dates');
    if (request.from > request.to) return invalid('from must not be after to');
    const range = { from: request.from, to: request.to };
    if (rangeDays(range) > MAX_REPORT_DAYS) return invalid(`the period must not exceed ${MAX_REPORT_DAYS} days`);
    if (buckets(range, request.granularity).length > MAX_TREND_BUCKETS) return invalid(`the trend must not exceed ${MAX_TREND_BUCKETS} buckets`);

    const current = await this.deps.facts.load(ctx, { businessId: request.businessId, ...range });
    if (current.outcome !== 'FACTS') return { outcome: 'UNAVAILABLE', code: 'FACTS_UNAVAILABLE', detail: current.detail };
    let previous: FinancialFacts | null = null;
    if (request.compare === 'previous') {
      const loaded = await this.deps.facts.load(ctx, { businessId: request.businessId, ...previousRange(range) });
      if (loaded.outcome !== 'FACTS') return { outcome: 'UNAVAILABLE', code: 'FACTS_UNAVAILABLE', detail: loaded.detail };
      previous = loaded.facts;
    }
    const report = buildFinancialReport({ current: current.facts, previous, granularity: request.granularity });
    const check = validateFinancialReport(report);
    if (!check.valid) return { outcome: 'UNAVAILABLE', code: 'REPORT_INVALID', detail: check.reasons.join(',') };
    return { outcome: 'REPORT', report };
  }
}
