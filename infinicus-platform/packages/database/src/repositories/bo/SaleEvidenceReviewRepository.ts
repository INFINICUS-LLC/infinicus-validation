import { createHash } from 'node:crypto';
import type { TenantContext } from '../../client.js';
import { withTenantTransaction } from '../../client.js';
import { minorUnitsOf } from '../../currency/minorUnits.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LIMIT = 100;
type Event = { id: string; event_type: string; previous_status: string | null; new_status: string | null; occurred_at: string; created_at: string };
type Payment = { id: string; currency_code: string; amount_applied: string; created_at: string };
type Credit = { id: string; invoice_id: string; currency_code: string; amount: string; credit_note_status: string; issue_date: string; updated_at: string };
export type SaleEvidenceBlocker =
  | 'ORDER_NOT_FOUND' | 'NOT_COMPLETED' | 'COMPLETION_EVENT_MISSING' | 'DUPLICATE_COMPLETION'
  | 'INVALID_COMPLETION_TIME' | 'PAYMENT_MISMATCH' | 'CURRENCY_MISMATCH'
  | 'CREDIT_CANCELLED' | 'REFUND_AMOUNT_INVALID'
  | 'SOURCE_HISTORY_MUTABLE' | 'REFUND_APPLICATION_TIME_MISSING' | 'UNLINKED_REFUNDS_UNDETECTABLE' | 'SOURCE_TRUNCATED';

export interface SaleEvidenceReview {
  authoritative: false;
  orderId: string;
  completionAt: string | null;
  currency: string | null;
  saleMinor: string | null;
  linkedCredits: readonly { id: string; status: string; amountMinor: string | null }[];
  blockers: readonly SaleEvidenceBlocker[];
  sourceDigest: string;
}

/** Exact decimal-to-minor-unit conversion for stored numeric(18,4); no JavaScript money float. */
export function storedAmountToMinor(amount: string, currency: string): bigint | null {
  const exponent = minorUnitsOf(currency);
  if (exponent === null || !/^(0|[1-9]\d*)(?:\.\d{1,4})?$/.test(amount)) return null;
  const [whole, fraction = ''] = amount.split('.');
  if (fraction.slice(exponent).replace(/0/g, '') !== '') return null;
  return BigInt(whole) * 10n ** BigInt(exponent) + BigInt((fraction.slice(0, exponent) || '').padEnd(exponent, '0') || '0');
}

/** BO read-only inspection. It reports gaps; it never certifies an OM net-sales observation. */
export class SaleEvidenceReviewRepository {
  async read(ctx: TenantContext, businessId: string, orderId: string): Promise<SaleEvidenceReview> {
    if (!UUID.test(businessId) || !UUID.test(orderId)) throw new Error('sale evidence review requires UUID scope');
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<{
        status: string; currency: string; total: string; created_at: Date;
        events: Event[]; payments: Payment[]; credits: Credit[];
      }>(`SELECT o.operational_status AS status, o.currency_code AS currency, o.total_amount::text AS total,
             o.created_at,
             coalesce((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.occurred_at,e.id) FROM
               (SELECT id,event_type,previous_status,new_status,occurred_at,created_at
                  FROM business_operations.order_events WHERE order_id=o.id AND tenant_id=$1 AND workspace_id=$2 AND business_id=$3
                  ORDER BY occurred_at,id LIMIT 101) e), '[]'::jsonb) AS events,
             coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.created_at,p.id) FROM
               (SELECT id,currency_code,amount_applied::text,created_at
                  FROM business_operations.order_payments WHERE order_id=o.id AND tenant_id=$1 AND workspace_id=$2 AND business_id=$3
                  ORDER BY created_at,id LIMIT 101) p), '[]'::jsonb) AS payments,
             coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.issue_date,c.id) FROM
               (SELECT n.id,n.invoice_id,n.currency_code,n.amount::text,n.credit_note_status,n.issue_date,n.updated_at
                  FROM business_operations.credit_notes n JOIN platform.invoices i ON i.id=n.invoice_id
                 WHERE i.order_id=o.id AND i.tenant_id=$1 AND i.workspace_id=$2 AND i.business_id=$3
                   AND n.tenant_id=$1 AND n.workspace_id=$2 AND n.business_id=$3
                 ORDER BY n.issue_date,n.id LIMIT 101) c), '[]'::jsonb) AS credits
        FROM platform.orders o WHERE o.id=$4 AND o.tenant_id=$1 AND o.workspace_id=$2 AND o.business_id=$3`,
      [ctx.tenantId, ctx.workspaceId, businessId, orderId]);
      const row = result.rows[0];
      const events = row?.events.slice(0, LIMIT) ?? [];
      const payments = row?.payments.slice(0, LIMIT) ?? [];
      const credits = row?.credits.slice(0, LIMIT) ?? [];
      const blockers = new Set<SaleEvidenceBlocker>();
      if (!row) blockers.add('ORDER_NOT_FOUND');
      if (row && row.status !== 'completed') blockers.add('NOT_COMPLETED');
      const completions = events.filter((event) => event.event_type === 'completed' && event.previous_status === 'planned' && event.new_status === 'completed');
      if (row && completions.length === 0) blockers.add('COMPLETION_EVENT_MISSING');
      if (completions.length > 1) blockers.add('DUPLICATE_COMPLETION');
      const completionAt = completions.length === 1 ? new Date(completions[0].occurred_at).toISOString() : null;
      if (row && (!completionAt || new Date(completionAt).getTime() < new Date(row.created_at).getTime())) blockers.add('INVALID_COMPLETION_TIME');
      const sale = row ? storedAmountToMinor(row.total, row.currency) : null;
      if (row && sale === null) blockers.add('CURRENCY_MISMATCH');
      let paid = 0n;
      for (const payment of payments) {
        const amount = storedAmountToMinor(payment.amount_applied, payment.currency_code);
        if (payment.currency_code !== row?.currency || amount === null) blockers.add('CURRENCY_MISMATCH');
        else paid += amount;
      }
      if (row && sale !== null && (payments.length === 0 ? sale !== 0n : paid !== sale)) blockers.add('PAYMENT_MISMATCH');
      let credited = 0n;
      const linkedCredits = credits.map((credit) => {
        const amount = storedAmountToMinor(credit.amount, credit.currency_code);
        if (credit.currency_code !== row?.currency || amount === null) blockers.add('CURRENCY_MISMATCH');
        if (credit.credit_note_status === 'cancelled') blockers.add('CREDIT_CANCELLED');
        if (credit.credit_note_status === 'applied' && amount !== null && credit.currency_code === row?.currency) credited += amount;
        return { id: credit.id, status: credit.credit_note_status, amountMinor: amount?.toString() ?? null };
      });
      if (sale !== null && credited > sale) blockers.add('REFUND_AMOUNT_INVALID');
      if (row && (row.events.length > LIMIT || row.payments.length > LIMIT || row.credits.length > LIMIT)) blockers.add('SOURCE_TRUNCATED');
      // Current BO tables do not prove immutable lifecycle history, refund application time or the absence of unlinked refunds.
      blockers.add('SOURCE_HISTORY_MUTABLE'); blockers.add('REFUND_APPLICATION_TIME_MISSING'); blockers.add('UNLINKED_REFUNDS_UNDETECTABLE');
      const sourceDigest = `sha256:${createHash('sha256').update(JSON.stringify({ businessId, orderId, row })).digest('hex')}`;
      return { authoritative: false, orderId, completionAt, currency: row?.currency ?? null,
        saleMinor: sale?.toString() ?? null, linkedCredits, blockers: [...blockers], sourceDigest };
    });
  }
}
