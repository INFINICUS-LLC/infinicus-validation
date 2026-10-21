// OM-OBS-1 - READ-ONLY facts for the Outcome Monitoring health view of ONE business.
//
// Every statement here is a SELECT under the caller's tenant and workspace (RLS applies; FORCE RLS on every table read). It reads only
// facts that already exist: OM's own execution verifications, monitored actions and observations, and the platform's event records for the
// execution notification OM consumes (outbox, delivery attempts, dead letters). It writes nothing, replays nothing, judges nothing and invents
// no state: it returns what is stored, grouped. Classification and attention rules belong to the OM runtime, not to this file.
//
// Dead-letter and delivery rows hold the whole event; only references and stable failure codes leave this method (never the stored event body,
// never free-text failure messages).

import type { TenantContext } from '../../client.js';
import { withTenantTransaction } from '../../client.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const S = 'outcome_monitoring';
type Json = Record<string, unknown>;
const TS = (col: string) => `to_char(date_trunc('milliseconds', ${col}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export interface OutcomeMonitoringHealthOptions {
  /** The event type of the execution notification OM consumes (owned by event-contracts, supplied by the caller). */
  announcedEventType: string;
  /** The delivery destination (consumer) OM is registered under. */
  consumerName: string;
  windowSeconds: number;
  listLimit: number;
}

export type AnnouncedExecutionClass = 'AWAITING_DELIVERY' | 'DEAD_LETTERED' | 'DELIVERED_NOT_VERIFIED';

export interface OutcomeMonitoringHealthSnapshot {
  databaseNow: string;
  verifications: {
    total: number;
    byExecutionState: Record<string, number>;
    byOutcomeState: Record<string, number>;
    byExecutionOutcome: Record<string, number>;
    /** Rows stored as a verified outcome. The database refuses them today; the count exists so any such row is visible rather than assumed away. */
    verifiedOutcomeRows: number;
    unlinkedToMonitoredAction: number;
    lastVerifiedAt: string | null;
  };
  monitoredActions: { open: number; openWithoutVerification: number };
  /** Observation records by workflow status (the human-recorded path; not execution evidence). */
  observationsByStatus: Record<string, number>;
  announced: {
    total: number;
    verified: number;
    awaitingDelivery: number;
    deadLettered: number;
    deliveredNotVerified: number;
    oldestAwaitingAgeSeconds: number | null;
    /** Executions announced but not verified, oldest first, bounded. */
    pending: { outboxEventId: string; executionId: string | null; class: AnnouncedExecutionClass; outboxStatus: string; attempts: number; occurredAt: string; ageSeconds: number }[];
  };
  deliveryFailures: { failureCode: string; status: string; total: number; inWindow: number; latestAt: string }[];
  deadLetters: {
    byStatus: Record<string, number>;
    byCode: { code: string; total: number; pending: number }[];
    /** Pending (not replayed, not abandoned) dead letters, oldest first, bounded. */
    pending: { id: string; originalEventId: string | null; executionId: string | null; code: string; retryable: boolean | null; attempts: number; firstFailedAt: string; lastFailedAt: string }[];
  };
}

const empty = (now: string): OutcomeMonitoringHealthSnapshot => ({
  databaseNow: now,
  verifications: { total: 0, byExecutionState: {}, byOutcomeState: {}, byExecutionOutcome: {}, verifiedOutcomeRows: 0, unlinkedToMonitoredAction: 0, lastVerifiedAt: null },
  monitoredActions: { open: 0, openWithoutVerification: 0 },
  observationsByStatus: {},
  announced: { total: 0, verified: 0, awaitingDelivery: 0, deadLettered: 0, deliveredNotVerified: 0, oldestAwaitingAgeSeconds: null, pending: [] },
  deliveryFailures: [],
  deadLetters: { byStatus: {}, byCode: [], pending: [] },
});

const tally = (rows: Json[], key: string): Record<string, number> => Object.fromEntries(rows.map((r) => [String(r[key]), Number(r.n)]));

export class OutcomeMonitoringHealthRepository {
  async healthSnapshot(ctx: TenantContext, businessId: string, opts: OutcomeMonitoringHealthOptions): Promise<OutcomeMonitoringHealthSnapshot> {
    const limit = Math.max(1, Math.min(100, Math.trunc(opts.listLimit)));
    const windowSeconds = Math.max(1, Math.trunc(opts.windowSeconds));
    if (!UUID.test(businessId)) return empty(new Date().toISOString());
    const V = `${S}.action_execution_verifications`;

    return withTenantTransaction(ctx, async (client) => {
      const now = await client.query<Json>(`SELECT ${TS('clock_timestamp()')} AS now`);
      const agg = await client.query<Json>(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE outcome_state = 'OUTCOME_VERIFIED')::int AS verified_rows,
                count(*) FILTER (WHERE monitored_action_id IS NULL)::int AS unlinked,
                ${TS('max(verified_at)')} AS last_verified_at
           FROM ${V} WHERE business_id = $1`, [businessId]);
      const byExec = await client.query<Json>(`SELECT execution_state AS k, count(*)::int AS n FROM ${V} WHERE business_id = $1 GROUP BY 1`, [businessId]);
      const byOutcome = await client.query<Json>(`SELECT outcome_state AS k, count(*)::int AS n FROM ${V} WHERE business_id = $1 GROUP BY 1`, [businessId]);
      const byResult = await client.query<Json>(`SELECT execution_outcome AS k, count(*)::int AS n FROM ${V} WHERE business_id = $1 GROUP BY 1`, [businessId]);

      const monitored = await client.query<Json>(
        `SELECT count(*)::int AS open,
                count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM ${V} v WHERE v.business_id = m.business_id AND (v.monitored_action_id = m.id OR v.approved_action_id = m.approved_action_id)))::int AS open_without
           FROM ${S}.monitored_actions m WHERE m.business_id = $1 AND m.status IN ('pending','in_progress')`, [businessId]);
      const obs = await client.query<Json>(`SELECT status AS k, count(*)::int AS n FROM ${S}.outcome_observations WHERE business_id = $1 GROUP BY 1`, [businessId]);

      // Executions announced to OM, and what became of each. "Verified" means OM holds its own verification row for that execution.
      const announced = await client.query<Json>(
        `WITH a AS (
           SELECT e.id, e.status, e.attempt_count, e.occurred_at, e.payload ->> 'executionId' AS execution_id,
                  EXISTS (SELECT 1 FROM ${V} v WHERE v.business_id = e.business_id AND v.execution_id::text = e.payload ->> 'executionId') AS verified
             FROM events.outbox_events e WHERE e.business_id = $1 AND e.event_type = $2)
         SELECT count(*)::int AS total,
                count(*) FILTER (WHERE verified)::int AS verified,
                count(*) FILTER (WHERE NOT verified AND status IN ('pending','processing','failed'))::int AS awaiting,
                count(*) FILTER (WHERE NOT verified AND status = 'dead_lettered')::int AS dead,
                count(*) FILTER (WHERE NOT verified AND status = 'published')::int AS delivered_not_verified,
                floor(extract(epoch FROM (clock_timestamp() - min(occurred_at) FILTER (WHERE NOT verified AND status IN ('pending','processing','failed')))))::int AS oldest_awaiting
           FROM a`, [businessId, opts.announcedEventType]);
      const pending = await client.query<Json>(
        `SELECT e.id, e.status, e.attempt_count, ${TS('e.occurred_at')} AS occurred_at, e.payload ->> 'executionId' AS execution_id,
                floor(extract(epoch FROM (clock_timestamp() - e.occurred_at)))::int AS age
           FROM events.outbox_events e
          WHERE e.business_id = $1 AND e.event_type = $2
            AND NOT EXISTS (SELECT 1 FROM ${V} v WHERE v.business_id = e.business_id AND v.execution_id::text = e.payload ->> 'executionId')
          ORDER BY e.occurred_at ASC, e.id ASC LIMIT $3`, [businessId, opts.announcedEventType, limit]);

      const failures = await client.query<Json>(
        `SELECT COALESCE(a.failure_code, 'UNSPECIFIED') AS code, a.status, count(*)::int AS total,
                count(*) FILTER (WHERE a.attempted_at >= clock_timestamp() - make_interval(secs => $4))::int AS in_window,
                ${TS('max(a.attempted_at)')} AS latest
           FROM events.event_delivery_attempts a
           JOIN events.outbox_events o ON o.id = a.outbox_event_id
           JOIN events.event_subscriptions s ON s.id = a.subscription_id
          WHERE o.business_id = $1 AND o.event_type = $2 AND s.destination_ref = $3 AND a.status IN ('failed','timed_out')
          GROUP BY 1, 2 ORDER BY 1, 2`, [businessId, opts.announcedEventType, opts.consumerName, windowSeconds]);

      const dlq = `FROM events.dead_letter_events d WHERE d.original_event ->> 'event_type' = $2 AND d.original_event ->> 'business_id' = $1::text`;
      const code = `COALESCE(substring(d.failure_reason from '"code"\\s*:\\s*"([^"]*)"'), 'UNSPECIFIED')`;
      const dlStatus = await client.query<Json>(`SELECT d.replay_status AS k, count(*)::int AS n ${dlq} GROUP BY 1`, [businessId, opts.announcedEventType]);
      const dlCode = await client.query<Json>(
        `SELECT ${code} AS code, count(*)::int AS total, count(*) FILTER (WHERE d.replay_status = 'pending')::int AS pending ${dlq} GROUP BY 1 ORDER BY 3 DESC, 1`,
        [businessId, opts.announcedEventType]);
      const dlPending = await client.query<Json>(
        `SELECT d.id, d.original_event_id, d.original_event -> 'payload' ->> 'executionId' AS execution_id, ${code} AS code,
                substring(d.failure_reason from '"retryable"\\s*:\\s*(true|false)') AS retryable, d.attempt_count,
                ${TS('d.first_failed_at')} AS first_failed_at, ${TS('d.last_failed_at')} AS last_failed_at
           ${dlq} AND d.replay_status = 'pending' ORDER BY d.last_failed_at ASC, d.id ASC LIMIT $3`, [businessId, opts.announcedEventType, limit]);

      const a = announced.rows[0] ?? {};
      return {
        databaseNow: now.rows[0].now as string,
        verifications: {
          total: Number(agg.rows[0].total), byExecutionState: tally(byExec.rows, 'k'), byOutcomeState: tally(byOutcome.rows, 'k'), byExecutionOutcome: tally(byResult.rows, 'k'),
          verifiedOutcomeRows: Number(agg.rows[0].verified_rows), unlinkedToMonitoredAction: Number(agg.rows[0].unlinked), lastVerifiedAt: (agg.rows[0].last_verified_at as string | null) ?? null,
        },
        monitoredActions: { open: Number(monitored.rows[0].open), openWithoutVerification: Number(monitored.rows[0].open_without) },
        observationsByStatus: tally(obs.rows, 'k'),
        announced: {
          total: Number(a.total ?? 0), verified: Number(a.verified ?? 0), awaitingDelivery: Number(a.awaiting ?? 0), deadLettered: Number(a.dead ?? 0),
          deliveredNotVerified: Number(a.delivered_not_verified ?? 0), oldestAwaitingAgeSeconds: a.oldest_awaiting === null || a.oldest_awaiting === undefined ? null : Number(a.oldest_awaiting),
          pending: pending.rows.map((r) => ({
            outboxEventId: r.id as string, executionId: (r.execution_id as string | null) ?? null,
            class: (r.status === 'dead_lettered' ? 'DEAD_LETTERED' : r.status === 'published' ? 'DELIVERED_NOT_VERIFIED' : 'AWAITING_DELIVERY') as AnnouncedExecutionClass,
            outboxStatus: r.status as string, attempts: Number(r.attempt_count), occurredAt: r.occurred_at as string, ageSeconds: Math.max(0, Number(r.age)),
          })),
        },
        deliveryFailures: failures.rows.map((r) => ({ failureCode: r.code as string, status: r.status as string, total: Number(r.total), inWindow: Number(r.in_window), latestAt: r.latest as string })),
        deadLetters: {
          byStatus: tally(dlStatus.rows, 'k'),
          byCode: dlCode.rows.map((r) => ({ code: r.code as string, total: Number(r.total), pending: Number(r.pending) })),
          pending: dlPending.rows.map((r) => ({
            id: r.id as string, originalEventId: (r.original_event_id as string | null) ?? null, executionId: (r.execution_id as string | null) ?? null, code: r.code as string,
            retryable: r.retryable === 'true' ? true : r.retryable === 'false' ? false : null, attempts: Number(r.attempt_count),
            firstFailedAt: r.first_failed_at as string, lastFailedAt: r.last_failed_at as string,
          })),
        },
      };
    });
  }
}
