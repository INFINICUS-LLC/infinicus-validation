import { describe, expect, it } from 'vitest';
import {
  ACTION_AUTHORIZED_ALIAS, ACTION_AUTHORIZED_CONTRACT, ACTION_AUTHORIZED_EVENT_TYPE, BusinessEventContractRegistry,
  actionAuthorizedEventId, actionAuthorizedIdempotencyKey, buildActionAuthorizedEvent, isActionAuthorizedPayload,
  registerActionAuthorizedContract, validateBusinessEventEnvelope,
} from '../index.js';
import type { ActionAuthorizedPayload } from '../index.js';

const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const payload = (over: Record<string, unknown> = {}): ActionAuthorizedPayload => ({
  packageId: U(1), packageVersion: 1, digest: `sha256:${'a'.repeat(64)}`,
  scope: { tenantId: U(2), workspaceId: U(3), businessId: U(4) },
  actionType: { code: 'inventory_reorder_policy_update', schemaVersion: '1' }, automationLevel: 2,
  expiresAt: '2026-10-20T10:00:00.000Z', decisionId: U(5), issuedAt: '2026-10-12T10:00:00.000Z', ...over,
}) as ActionAuthorizedPayload;
const built = (p = payload()) => buildActionAuthorizedEvent({ payload: p, correlationId: U(9), causationId: U(8), recordedAt: '2026-10-12T10:00:01.000Z' });

describe('control_loop.action.authorized@1', () => {
  it('names the canonical type, version and manifest alias', () => {
    expect(ACTION_AUTHORIZED_EVENT_TYPE).toBe('control_loop.action.authorized');
    expect(ACTION_AUTHORIZED_ALIAS).toBe('ACTION_AUTHORIZED');
    expect(ACTION_AUTHORIZED_CONTRACT).toMatchObject({ eventVersion: '1', ownerDomain: 'control_loop', status: 'active', compatibilityAliases: ['ACTION_AUTHORIZED'] });
  });

  it('accepts the exact reference-only payload (with or without an expiry)', () => {
    expect(isActionAuthorizedPayload(payload())).toBe(true);
    expect(isActionAuthorizedPayload(payload({ expiresAt: null }))).toBe(true);
  });

  it('is closed: any extra key is refused, so no package body, parameters or boundaries can ride along', () => {
    for (const extra of ['package', 'parameters', 'action', 'accountableOwner', 'boundaries', 'lineage', 'body', 'document']) {
      expect(isActionAuthorizedPayload({ ...payload(), [extra]: { x: 1 } }), extra).toBe(false);
    }
    expect(isActionAuthorizedPayload({ ...payload(), scope: { ...payload().scope, extra: 1 } })).toBe(false);
    expect(isActionAuthorizedPayload({ ...payload(), actionType: { code: 'a', schemaVersion: '1', parameters: {} } })).toBe(false);
  });

  it('refuses every missing or malformed field', () => {
    const bad: Record<string, unknown>[] = [
      { packageId: 'x' }, { packageId: undefined }, { packageVersion: 0 }, { packageVersion: 1.5 }, { packageVersion: '1' },
      { digest: 'sha256:abc' }, { digest: `md5:${'a'.repeat(64)}` }, { digest: `sha256:${'A'.repeat(64)}` },
      { scope: undefined }, { scope: { tenantId: U(2), workspaceId: U(3) } }, { scope: { tenantId: 'x', workspaceId: U(3), businessId: U(4) } },
      { actionType: { code: '', schemaVersion: '1' } }, { actionType: { code: 'a' } }, { actionType: null },
      { automationLevel: 0 }, { automationLevel: '2' }, { expiresAt: '2026-10-20' }, { expiresAt: 'soon' }, { expiresAt: undefined },
      { decisionId: 'x' }, { issuedAt: '2026-10-12T10:00:00Z' }, { issuedAt: null },
    ];
    for (const over of bad) expect(isActionAuthorizedPayload(payload(over)), JSON.stringify(over)).toBe(false);
    for (const v of [null, undefined, 'x', 1, [], []]) expect(isActionAuthorizedPayload(v)).toBe(false);
  });

  it('builds a valid, registry-accepted, scope-bound envelope for the package version', () => {
    const registry = new BusinessEventContractRegistry();
    registerActionAuthorizedContract(registry);
    const e = built();
    expect(validateBusinessEventEnvelope(e)).toEqual({ valid: true, reasons: [] });
    expect(registry.validate(e)).toEqual({ valid: true, reasons: [], canonicalEventType: ACTION_AUTHORIZED_EVENT_TYPE });
    expect(e).toMatchObject({
      eventType: 'control_loop.action.authorized', eventVersion: '1', tenantId: U(2), workspaceId: U(3), businessId: U(4), sourceDomain: 'control_loop',
      aggregateType: 'authorized_action_package', aggregateId: U(1), correlationId: U(9), causationId: U(8),
      idempotencyKey: `aap:${U(1)}:1`, provenance: { evidenceClass: 'ACTUAL' }, sensitivity: 'internal', occurredAt: '2026-10-12T10:00:00.000Z',
    });
  });

  it('the registry rejects a malformed payload and an unregistered registry knows nothing (registration is explicit)', () => {
    const registry = new BusinessEventContractRegistry();
    expect(registry.validate(built()).reasons).toEqual(['event_contract_not_registered']);
    registerActionAuthorizedContract(registry);
    const tampered = { ...built(), payload: { ...payload(), parameters: { reorderPoint: 1 } } };
    expect(registry.validate(tampered).reasons).toEqual(['event_payload_invalid']);
    expect(() => registerActionAuthorizedContract(registry)).toThrow('duplicate_event_contract');
  });

  it('refuses to build an envelope from a payload that is not exactly the reference shape', () => {
    expect(() => built({ ...payload(), body: {} } as never)).toThrow('action_authorized_payload_invalid');
    expect(() => built(payload({ digest: 'nope' }))).toThrow('action_authorized_payload_invalid');
  });

  it('idempotency: one deterministic event id per package version (UUID-shaped), distinct across versions and packages', () => {
    expect(actionAuthorizedIdempotencyKey(U(1), 3)).toBe(`aap:${U(1)}:3`);
    const a = actionAuthorizedEventId(U(1), 1);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(actionAuthorizedEventId(U(1), 1)).toBe(a);
    expect(actionAuthorizedEventId(U(1), 2)).not.toBe(a);
    expect(actionAuthorizedEventId(U(7), 1)).not.toBe(a);
    expect(built().eventId).toBe(a);
  });
});
