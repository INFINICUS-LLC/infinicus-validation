import { describe, expect, it } from 'vitest';
import { BusinessEventContractRegistry } from '@infinicus/event-contracts';
import {
  CanonicalEventPublisher,
  LegacyOutboxCompatibilityRegistry,
  assertReplayAuthorized,
  outboxRecordToCanonicalEvent,
  type LegacyOutboxRecord,
} from '../src/eventing/index.js';

function legacyRow(overrides: Partial<LegacyOutboxRecord> = {}): LegacyOutboxRecord {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    event_type: 'bo.inventory.movement_recorded',
    event_version: '1.0',
    tenant_id: '22222222-2222-4222-8222-222222222222',
    workspace_id: '33333333-3333-4333-8333-333333333333',
    business_id: null,
    correlation_id: '44444444-4444-4444-8444-444444444444',
    causation_id: null,
    aggregate_type: 'inventory_movement',
    aggregate_id: '55555555-5555-4555-8555-555555555555',
    payload: { quantity: 5 },
    headers: {},
    occurred_at: '2026-10-05T02:00:00.000Z',
    ...overrides,
  };
}

describe('LegacyOutboxCompatibilityRegistry', () => {
  it('requires an explicit profile rather than silently inventing provenance', () => {
    const registry = new LegacyOutboxCompatibilityRegistry();
    expect(() => outboxRecordToCanonicalEvent(legacyRow(), registry))
      .toThrow(/legacy_event_profile_required/);
  });

  it('maps a registered legacy event without coercing evidence classification', () => {
    const registry = new LegacyOutboxCompatibilityRegistry();
    registry.register({
      legacyEventType: 'bo.inventory.movement_recorded',
      canonicalEventType: 'operations.inventory.movement_recorded',
      sourceDomain: 'operations',
      sourceService: 'legacy-business-operations',
      schemaName: 'operations.inventory.movement_recorded',
      schemaVersion: '1.0',
      evidenceClass: 'ACTUAL',
      sensitivity: 'internal',
    });

    const event = outboxRecordToCanonicalEvent(legacyRow(), registry);
    expect(event.eventType).toBe('operations.inventory.movement_recorded');
    expect(event.provenance.evidenceClass).toBe('ACTUAL');
    expect(event.metadata).toEqual({
      legacyEventType: 'bo.inventory.movement_recorded',
    });
  });

  it('preserves canonical header provenance exactly', () => {
    const registry = new LegacyOutboxCompatibilityRegistry();
    const row = legacyRow({
      event_type: 'intelligence.forecast.generated',
      headers: {
        businessEvent: {
          sourceDomain: 'intelligence',
          sourceService: 'forecasting',
          schemaName: 'intelligence.forecast.generated',
          schemaVersion: '1.0',
          sensitivity: 'internal',
          metadata: { modelVersion: 'm1' },
          provenance: {
            evidenceClass: 'FORECAST',
            sourceSystem: 'forecasting',
          },
        },
      },
    });

    const event = outboxRecordToCanonicalEvent(row, registry);
    expect(event.provenance.evidenceClass).toBe('FORECAST');
    expect(event.metadata).toEqual({ modelVersion: 'm1' });
  });

  it('rejects canonical publication without workspace context', () => {
    const registry = new LegacyOutboxCompatibilityRegistry();
    expect(() => outboxRecordToCanonicalEvent(
      legacyRow({ workspace_id: null }),
      registry,
    )).toThrow(/workspace_required/);
  });
});

describe('replay authorization', () => {
  it('requires delivery-only replay', () => {
    expect(() => assertReplayAuthorized(
      { eventType: 'operations.inventory.movement_recorded' },
      { approvedBy: 'admin', reason: 'consumer retry', mode: 'DELIVERY_ONLY' },
    )).not.toThrow();
  });

  it('blocks action-related replay without Approved Business Action reference', () => {
    expect(() => assertReplayAuthorized(
      { eventType: 'control_loop.action.approved' },
      { approvedBy: 'admin', reason: 'redelivery', mode: 'DELIVERY_ONLY' },
    )).toThrow(/aba_reference/);
  });

  it('allows action evidence redelivery only when ABA lineage is explicit', () => {
    expect(() => assertReplayAuthorized(
      { eventType: 'control_loop.action.approved' },
      {
        approvedBy: 'admin',
        reason: 'consumer redelivery only',
        mode: 'DELIVERY_ONLY',
        approvalActionId: 'ABA-123',
      },
    )).not.toThrow();
  });
});

describe('CanonicalEventPublisher', () => {
  it('validates contract, appends immutable evidence, then marks delivery published', async () => {
    const contracts = new BusinessEventContractRegistry();
    contracts.register({
      eventType: 'operations.inventory.movement_recorded',
      eventVersion: '1.0',
      schemaName: 'operations.inventory.movement_recorded',
      schemaVersion: '1.0',
      ownerDomain: 'operations',
      producer: 'legacy-business-operations',
      supportedConsumers: ['intelligence'],
      sensitivity: 'internal',
      status: 'active',
      effectiveFrom: '2026-10-05T00:00:00.000Z',
      deprecatedAt: null,
      compatibilityAliases: ['bo.inventory.movement_recorded'],
      validatePayload: (payload: unknown): payload is Record<string, unknown> =>
        Boolean(payload) && typeof payload === 'object' && !Array.isArray(payload),
    });

    const compatibility = new LegacyOutboxCompatibilityRegistry();
    compatibility.register({
      legacyEventType: 'bo.inventory.movement_recorded',
      canonicalEventType: 'operations.inventory.movement_recorded',
      sourceDomain: 'operations',
      sourceService: 'legacy-business-operations',
      schemaName: 'operations.inventory.movement_recorded',
      schemaVersion: '1.0',
      evidenceClass: 'ACTUAL',
      sensitivity: 'internal',
    });

    const calls: string[] = [];
    const ledger = {
      append: async (_ctx: unknown, event: { eventType: string }) => {
        calls.push(`ledger:${event.eventType}`);
        return event;
      },
    };
    const outbox = {
      markPublished: async (_ctx: unknown, id: string) => {
        calls.push(`outbox:${id}`);
      },
    };

    const publisher = new CanonicalEventPublisher(
      contracts,
      compatibility,
      ledger as never,
      outbox as never,
    );

    const result = await publisher.publishClaimed(
      {
        tenantId: '22222222-2222-4222-8222-222222222222',
        workspaceId: '33333333-3333-4333-8333-333333333333',
        userId: '66666666-6666-4666-8666-666666666666',
      },
      legacyRow(),
    );

    expect(result).toMatchObject({
      eventType: 'operations.inventory.movement_recorded',
      status: 'published',
    });
    expect(calls).toEqual([
      'ledger:operations.inventory.movement_recorded',
      'outbox:11111111-1111-4111-8111-111111111111',
    ]);
  });
});
