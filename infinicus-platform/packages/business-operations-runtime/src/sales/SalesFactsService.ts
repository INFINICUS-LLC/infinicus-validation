/**
 * Read-only Business Operations source of the raw sales facts Business Intelligence derives its reports from (NEW-BI-02; contract
 * `bo-sales-facts/1`). It validates the request, reads through the BO-owned SalesFactsRepository (tenant and workspace from the caller's context,
 * RLS applies) and returns the facts stamped with the contract name. It WRITES NOTHING, converts no currency, nets nothing and derives nothing: averages,
 * margins, comparisons and trends belong to Business Intelligence, which reaches this service through a structural port joined at the composition root.
 */
import { SalesFactsRepository, type TenantContext } from '@infinicus/database';
import { BO_SALES_FACTS_CONTRACT, type SalesFacts } from '@infinicus/handoff-contracts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A bound on one request: two years of days, so a single read stays cheap. Business Intelligence applies its own, tighter, report limits. */
export const MAX_SALES_FACTS_RANGE_DAYS = 732;

export interface SalesFactsRequest { businessId: string; from: string; to: string }

export type SalesFactsResult =
  | { outcome: 'FACTS'; facts: SalesFacts }
  | { outcome: 'UNAVAILABLE'; code: 'INVALID_REQUEST'; detail: string };

const dayNumber = (isoDate: string): number => Math.floor(Date.UTC(Number(isoDate.slice(0, 4)), Number(isoDate.slice(5, 7)) - 1, Number(isoDate.slice(8, 10))) / 86_400_000);
function isRealDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;   // toISOString() throws on an invalid date, hence the guard
}

export class SalesFactsService {
  constructor(private readonly repository: Pick<SalesFactsRepository, 'read'> = new SalesFactsRepository()) {}

  async load(ctx: TenantContext, request: SalesFactsRequest): Promise<SalesFactsResult> {
    if (!UUID.test(request.businessId)) return { outcome: 'UNAVAILABLE', code: 'INVALID_REQUEST', detail: 'businessId must be a lowercase UUID' };
    if (!isRealDate(request.from) || !isRealDate(request.to)) return { outcome: 'UNAVAILABLE', code: 'INVALID_REQUEST', detail: 'from and to must be real YYYY-MM-DD dates' };
    if (request.from > request.to) return { outcome: 'UNAVAILABLE', code: 'INVALID_REQUEST', detail: 'from must not be after to' };
    if (dayNumber(request.to) - dayNumber(request.from) + 1 > MAX_SALES_FACTS_RANGE_DAYS) {
      return { outcome: 'UNAVAILABLE', code: 'INVALID_REQUEST', detail: `the range must not exceed ${MAX_SALES_FACTS_RANGE_DAYS} days` };
    }
    const raw = await this.repository.read(ctx, request.businessId, request.from, request.to);
    return { outcome: 'FACTS', facts: { contract: BO_SALES_FACTS_CONTRACT, businessId: request.businessId, range: { from: request.from, to: request.to }, ...raw } };
  }
}
