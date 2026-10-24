import { createHash } from 'node:crypto';
import type { TenantContext } from '../../client.js';
import { withTenantTransaction } from '../../client.js';
import { storedAmountToMinor } from './SaleEvidenceReviewRepository.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const digest = (value: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const instant = (value: string) => {
  if (!UTC.test(value)) return NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : NaN;
};

export interface SalesWindowReviewInput {
  businessId: string;
  currencyCode: string;
  executionAt: string;
  baselineOpenedAt: string;
  baselineClosedAt: string;
  windowOpenedAt: string;
  windowClosedAt: string;
}

export type SalesWindowBlocker =
  | 'INVALID_SCOPE' | 'INVALID_UTC_BOUNDS' | 'UNEQUAL_PERIODS' | 'EXECUTION_BOUNDARY_MISMATCH'
  | 'WINDOW_OPEN' | 'BASELINE_EMPTY' | 'WINDOW_EMPTY' | 'SOURCE_TRUNCATED'
  | 'DUPLICATE_COMPLETION' | 'INVALID_COMPLETION' | 'CURRENCY_MISMATCH'
  | 'SOURCE_MUTABLE' | 'REFUND_SOURCE_UNAVAILABLE';

export interface SalesWindowReview {
  authoritative: false;
  baselineCount: number;
  windowCount: number;
  sourceDigest: string;
  blockers: readonly SalesWindowBlocker[];
}

type Event = {
  id: string; order_id: string; occurred_at: string; previous_status: string | null; new_status: string | null;
  order_created_at: string; order_status: string; currency_code: string; total_amount: string;
};

/** Read-only BO source inspection. Counts completion transitions, never a net-sales or OM observation. */
export class SalesWindowEvidenceReviewRepository {
  async read(ctx: TenantContext, input: SalesWindowReviewInput): Promise<SalesWindowReview> {
    const blockers = new Set<SalesWindowBlocker>();
    const values = [input.baselineOpenedAt, input.baselineClosedAt, input.windowOpenedAt, input.windowClosedAt, input.executionAt].map(instant);
    const [baselineOpen, baselineClose, windowOpen, windowClose, executionAt] = values;
    if (!UUID.test(input.businessId) || !/^[A-Z]{3}$/.test(input.currencyCode) ||
        storedAmountToMinor('0', input.currencyCode) === null) blockers.add('INVALID_SCOPE');
    if (values.some((value) => !Number.isFinite(value)) || baselineOpen >= baselineClose ||
        windowOpen >= windowClose || baselineClose !== windowOpen) blockers.add('INVALID_UTC_BOUNDS');
    if (baselineClose - baselineOpen !== windowClose - windowOpen) blockers.add('UNEQUAL_PERIODS');
    if (windowOpen !== executionAt) blockers.add('EXECUTION_BOUNDARY_MISMATCH');
    const base = { businessId: input.businessId, currencyCode: input.currencyCode,
      baselineOpenedAt: input.baselineOpenedAt, baselineClosedAt: input.baselineClosedAt,
      windowOpenedAt: input.windowOpenedAt, windowClosedAt: input.windowClosedAt, executionAt: input.executionAt };
    // Invalid bounds never reach PostgreSQL. An empty result is not a zero-sales measurement.
    if (blockers.size > 0) return { authoritative: false, baselineCount: 0, windowCount: 0,
      sourceDigest: digest(base), blockers: [...blockers, 'SOURCE_MUTABLE', 'REFUND_SOURCE_UNAVAILABLE'] };
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<{ captured_at: Date; events: Event[] }>(
        `SELECT clock_timestamp() AS captured_at,
          coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.occurred_at,s.id) FROM (
            SELECT e.id,e.order_id,e.occurred_at,e.previous_status,e.new_status,
                   o.created_at AS order_created_at,o.operational_status AS order_status,
                   o.currency_code,o.total_amount::text
              FROM business_operations.order_events e
              JOIN platform.orders o ON o.id=e.order_id AND o.tenant_id=e.tenant_id
                AND o.workspace_id=e.workspace_id AND o.business_id=e.business_id
             WHERE e.tenant_id=$1 AND e.workspace_id=$2 AND e.business_id=$3
               AND e.event_type='completed' AND e.occurred_at >= $4::timestamptz
               AND e.occurred_at < $5::timestamptz
             ORDER BY e.occurred_at,e.id LIMIT 201
          ) s), '[]'::jsonb) AS events`,
        [ctx.tenantId, ctx.workspaceId, input.businessId, input.baselineOpenedAt, input.windowClosedAt]);
      const row = result.rows[0];
      const events = row.events;
      const baseline = events.filter((event) => Date.parse(event.occurred_at) < windowOpen);
      const window = events.filter((event) => Date.parse(event.occurred_at) >= windowOpen);
      if (row.captured_at.getTime() < windowClose) blockers.add('WINDOW_OPEN');
      if (baseline.length === 0) blockers.add('BASELINE_EMPTY');
      if (window.length === 0) blockers.add('WINDOW_EMPTY');
      if (events.length > 200) blockers.add('SOURCE_TRUNCATED');
      const seen = new Set<string>();
      for (const event of events) {
        if (seen.has(event.order_id)) blockers.add('DUPLICATE_COMPLETION');
        seen.add(event.order_id);
        if (event.previous_status !== 'planned' || event.new_status !== 'completed' ||
            event.order_status !== 'completed' || Date.parse(event.occurred_at) < Date.parse(event.order_created_at))
          blockers.add('INVALID_COMPLETION');
        if (event.currency_code !== input.currencyCode || storedAmountToMinor(event.total_amount, event.currency_code) === null)
          blockers.add('CURRENCY_MISMATCH');
      }
      // The existing lifecycle and refund sources are not governed immutable history.
      blockers.add('SOURCE_MUTABLE'); blockers.add('REFUND_SOURCE_UNAVAILABLE');
      return { authoritative: false, baselineCount: baseline.length, windowCount: window.length,
        sourceDigest: digest({ ...base, events }), blockers: [...blockers] };
    });
  }
}
