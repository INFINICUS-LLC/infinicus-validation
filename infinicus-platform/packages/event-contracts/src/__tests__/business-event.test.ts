import { describe, expect, it } from 'vitest';
import {
  BusinessEventContractRegistry,
  LEGACY_EVENT_ALIASES,
  validateBusinessEventEnvelope,
  type BusinessEventEnvelope,
} from '../index.js';

const baseEvent = (): BusinessEventEnvelope<Record<string, unknown>> => ({
  eventId: '11111111-1111-4111-8111-111111111111',
  eventType: 'operations.inventory.movement_recorded',
  eventVersion: '1.0',
  tenantId: '22222222-2222-4222-8222-222222222222',
  workspaceId: '33333333-3333-4333-8333-333333333333',
  businessId: null,
  sourceDomain: 'operations',
  sourceService: 'business-operations-runtime',
  aggregateType: 'inventory_movement',
  aggregateId: '44444444-4444-4444-8444-444444444444',
  correlationId: '55555555-5555-4555-8555-555555555555',
  causationId: null,
  occurredAt: '2026-10-04T18:00:00.000Z',
  recordedAt: '2026-10-04T18:00:01.000Z',
  actor: { actorType: 'service', actorId: 'operations-runtime' },
  idempotencyKey: 'movement:44444444-4444-4444-8444-444444444444',
  payload: { movementType: 'receipt', quantity: 5 },
  metadata: {},
  provenance: null,
  schemaName: 'operations.inventory.movement_recorded',
  schemaVersion: '1.0',
  sensitivity: 'internal',
});

describe('BusinessEventEnvelope validation', () => {
  it('accepts a complete canonical event', () => {
    expect(validateBusinessEventEnvelope(baseEvent())).toEqual({ valid: true, reasons: [] });
  });

  it('requires tenant and workspace context', () => {
    const event = baseEvent() as unknown as Record<string, unknown>;
    delete event.workspaceId;
    const result = validateBusinessEventEnvelope(event);
    expect(result.valid).toBe(false);
    expect(result.reasons).toContain('workspaceId_required');
  });

  it('rejects non-canonical event names', () => {
    const event = { ...baseEvent(), eventType: 'InventoryMoved' };
    expect(validateBusinessEventEnvelope(event).reasons).toContain('event_type_invalid');
  });

  it('rejects credential-like payload keys recursively', () => {
    const event = { ...baseEvent(), payload: { nested: { access_token: 'never-store-this' } } };
    const result = validateBusinessEventEnvelope(event);
    expect(result.valid).toBe(false);
    expect(result.reasons.some((reason) => reason.startsWith('credential_like_key_at_'))).toBe(true);
  });
});

describe('BusinessEventContractRegistry', () => {
  it('resolves frozen legacy aliases', () => {
    const registry = new BusinessEventContractRegistry();
    expect(registry.resolveEventType('bo.order.completed')).toBe('commerce.order.completed');
    expect(LEGACY_EVENT_ALIASES['bo.payment.received']).toBeUndefined();
  });

  it('rejects duplicate contract registrations', () => {
    const registry = new BusinessEventContractRegistry();
    const contract = {
      eventType: 'operations.inventory.movement_recorded',
      eventVersion: '1.0',
      schemaName: 'operations.inventory.movement_recorded',
      schemaVersion: '1.0',
      ownerDomain: 'operations' as const,
      producer: 'business-operations-runtime',
      supportedConsumers: ['intelligence'],
      sensitivity: 'internal' as const,
      status: 'active' as const,
      effectiveFrom: '2026-10-04T00:00:00.000Z',
      deprecatedAt: null,
      compatibilityAliases: ['bo.inventory.movement_recorded'],
      validatePayload: (payload: unknown): payload is Record<string, unknown> =>
        Boolean(payload) && typeof payload === 'object' && !Array.isArray(payload),
    };
    registry.register(contract);
    expect(() => registry.register(contract)).toThrow(/duplicate_event_contract/);
  });

  it('validates a registered canonical contract', () => {
    const registry = new BusinessEventContractRegistry();
    registry.register({
      eventType: 'operations.inventory.movement_recorded',
      eventVersion: '1.0',
      schemaName: 'operations.inventory.movement_recorded',
      schemaVersion: '1.0',
      ownerDomain: 'operations',
      producer: 'business-operations-runtime',
      supportedConsumers: ['intelligence'],
      sensitivity: 'internal',
      status: 'active',
      effectiveFrom: '2026-10-04T00:00:00.000Z',
      deprecatedAt: null,
      compatibilityAliases: ['bo.inventory.movement_recorded'],
      validatePayload: (payload: unknown): payload is Record<string, unknown> =>
        Boolean(payload) && typeof payload === 'object' && !Array.isArray(payload),
    });
    expect(registry.validate(baseEvent())).toMatchObject({
      valid: true,
      canonicalEventType: 'operations.inventory.movement_recorded',
    });
  });
});
