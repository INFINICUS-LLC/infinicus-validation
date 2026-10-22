import { SalesFactsRepository, minorUnitsOf, type TenantContext, type SalesDayCurrencyFacts } from '@infinicus/database';
import { AmountNotRepresentableError, decimalToMinorUnits } from './decimalMinor.js';

/**
 * Business Operations' read-only sales facts for Business Intelligence. It owns the definitions (see SalesFactsRepository): a sale is a completed
 * order, the reporting day is the order's recorded date, one row is one day in one currency and currencies are never combined. It converts the exact
 * database decimals to integer minor units of each row's own currency and fails closed (UNAVAILABLE with a named code) rather than reporting an amount it
 * cannot state exactly or a currency it does not know. It writes nothing.
 *
 * BI consumes this through a structural port at the API composition root (BI never imports Business Operations).
 */
export interface SalesDayFacts {
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

export type SalesFactsResult =
  | { outcome: 'FACTS'; facts: SalesDayFacts[] }
  | { outcome: 'UNAVAILABLE'; code: 'UNSUPPORTED_CURRENCY' | 'AMOUNT_NOT_REPRESENTABLE'; detail: string };

export class SalesFactsService {
  constructor(private readonly repository: Pick<SalesFactsRepository, 'byDayAndCurrency'> = new SalesFactsRepository()) {}

  async load(ctx: TenantContext, request: { businessId: string; from: string; to: string }): Promise<SalesFactsResult> {
    const rows: SalesDayCurrencyFacts[] = await this.repository.byDayAndCurrency(ctx, request.businessId, request.from, request.to);
    const facts: SalesDayFacts[] = [];
    for (const row of rows) {
      const exponent = minorUnitsOf(row.currencyCode);
      if (exponent === null) return { outcome: 'UNAVAILABLE', code: 'UNSUPPORTED_CURRENCY', detail: `currency ${row.currencyCode} on ${row.orderDate} is not a supported ISO 4217 code` };
      try {
        facts.push({
          date: row.orderDate, currencyCode: row.currencyCode, currencyExponent: exponent,
          completedOrders: row.completedOrders, voidedOrders: row.voidedOrders, openOrders: row.openOrders, otherStatusOrders: row.otherStatusOrders,
          grossMinor: decimalToMinorUnits(row.grossAmount, exponent),
          discountMinor: decimalToMinorUnits(row.discountAmount, exponent),
          netMinor: decimalToMinorUnits(row.netAmount, exponent),
        });
      } catch (error) {
        if (error instanceof AmountNotRepresentableError) {
          return { outcome: 'UNAVAILABLE', code: 'AMOUNT_NOT_REPRESENTABLE', detail: `${row.currencyCode} on ${row.orderDate}: ${error.message}` };
        }
        throw error;
      }
    }
    return { outcome: 'FACTS', facts };
  }
}
