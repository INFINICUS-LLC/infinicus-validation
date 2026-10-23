import { describe, expect, it } from 'vitest';
import type { ActionExecutionVerification, GovernedMeasurementDefinition, InventoryOutcomeEvidence, TenantContext } from '@infinicus/database';
import { GovernedMeasurementRunner, type MeasurementRunnerPorts } from '../src/GovernedMeasurementRunner.js';

const ctx: TenantContext = { tenantId: '11111111-1111-4111-8111-111111111111', workspaceId: '22222222-2222-4222-8222-222222222222', userId: '33333333-3333-4333-8333-333333333333' };
const businessId = '44444444-4444-4444-8444-444444444444';
const executionId = '55555555-5555-4555-8555-555555555555';
const serviceAccountId = '66666666-6666-4666-8666-666666666666';
const itemId = '77777777-7777-4777-8777-777777777777';
const digest = `sha256:${'a'.repeat(64)}`;
const verification = {
  id: '88888888-8888-4888-8888-888888888888', tenantId: ctx.tenantId, workspaceId: ctx.workspaceId,
  businessId, executionId, executionOutcome: 'SUCCEEDED', mutationResult: 'APPLIED',
  actionType: { code: 'inventory_reorder_policy_update', schemaVersion: '1' },
  target: { kind: 'inventory_item', id: itemId }, executionRecordedAt: '2026-10-20T00:00:00.000Z',
} as ActionExecutionVerification;
const definition = {
  id: '99999999-9999-4999-8999-999999999999', businessId, actionTypeCode: 'inventory_reorder_policy_update',
  actionTypeSchemaVersion: '1', metricCode: 'inventory_issue_count', definitionVersion: 1,
  baselineSeconds: 86_400, windowSeconds: 86_400, minimumObservations: 2,
} as GovernedMeasurementDefinition;
const issue = { id: itemId, warehouseId: itemId, quantity: '1.0000', occurredAt: '2026-10-19T01:00:00.000Z', createdAt: '2026-10-19T01:00:01.000Z' };
const evidence = { targetStatus: 'single_balance', balanceId: itemId, warehouseId: itemId,
  baseline: [issue], window: [issue, issue], truncated: false, capturedAt: '2026-10-22T00:00:00.000Z', digest } as InventoryOutcomeEvidence;

function fixture() {
  let active = true;
  let fact: ActionExecutionVerification | null = verification;
  let definitions: GovernedMeasurementDefinition[] = [definition];
  let source = evidence;
  let now = new Date('2026-10-22T00:00:00.000Z');
  const ports: MeasurementRunnerPorts = {
    isActiveRunner: async () => active,
    loadVerification: async () => fact,
    loadDefinitions: async () => definitions,
    readInventoryIssues: async () => source,
    databaseNow: async () => now,
  };
  return { runner: new GovernedMeasurementRunner(ports, serviceAccountId),
    setActive: (v: boolean) => { active = v; }, setFact: (v: ActionExecutionVerification | null) => { fact = v; },
    setDefinitions: (v: GovernedMeasurementDefinition[]) => { definitions = v; },
    setSource: (v: InventoryOutcomeEvidence) => { source = v; }, setNow: (v: Date) => { now = v; } };
}

describe('governed measurement assessment before attribution is available', () => {
  it('requires an active scoped service account and a visible verification', async () => {
    const f = fixture(); f.setActive(false);
    await expect(f.runner.assess(ctx, businessId, executionId)).rejects.toThrow('inactive');
    f.setActive(true); f.setFact(null);
    expect(await f.runner.assess(ctx, businessId, executionId)).toBeNull();
  });

  it('is deterministic and never claims a positive outcome without a definition', async () => {
    const f = fixture(); f.setDefinitions([]);
    const first = await f.runner.assess(ctx, businessId, executionId);
    expect(first).toMatchObject({ state: 'OUTCOME_INCONCLUSIVE', reason: 'NO_DEFINITION', definitionId: null });
    expect(await f.runner.assess(ctx, businessId, executionId)).toEqual(first);
  });

  it('waits for the approved window using the database clock', async () => {
    const f = fixture(); f.setNow(new Date('2026-10-20T12:00:00.000Z'));
    expect(await f.runner.assess(ctx, businessId, executionId)).toMatchObject({ state: 'OUTCOME_PENDING', reason: 'WINDOW_OPEN' });
  });

  it('rejects an out-of-scope or unapplied execution', async () => {
    const f = fixture(); f.setFact({ ...verification, businessId: itemId });
    expect(await f.runner.assess(ctx, businessId, executionId)).toMatchObject({ reason: 'SCOPE_MISMATCH' });
    f.setFact({ ...verification, mutationResult: 'NO_CHANGE' });
    expect(await f.runner.assess(ctx, businessId, executionId)).toMatchObject({ reason: 'NOTHING_APPLIED' });
  });

  it('keeps incomplete or ambiguous evidence inconclusive and attribution closed', async () => {
    const f = fixture();
    f.setSource({ ...evidence, targetStatus: 'ambiguous' });
    expect(await f.runner.assess(ctx, businessId, executionId)).toMatchObject({ reason: 'DATA_QUALITY' });
    f.setSource({ ...evidence, baseline: [] });
    expect(await f.runner.assess(ctx, businessId, executionId)).toMatchObject({ reason: 'BASELINE_MISSING' });
    f.setSource({ ...evidence, window: [issue] });
    expect(await f.runner.assess(ctx, businessId, executionId)).toMatchObject({ reason: 'INSUFFICIENT_DATA' });
    f.setSource(evidence);
    const result = await f.runner.assess(ctx, businessId, executionId);
    expect(result).toMatchObject({ reason: 'ATTRIBUTION_UNAVAILABLE', state: 'OUTCOME_INCONCLUSIVE', sourceDigest: digest });
    expect(await f.runner.assess(ctx, businessId, executionId)).toEqual(result);
  });

  it('persists one deterministic assessment through the dedicated writer port', async () => {
    const f = fixture();
    let writes = 0;
    const result = await f.runner.runAndRecord(ctx, businessId, executionId, {
      record: async (_ctx, _businessId, assessment) => {
        writes += 1;
        expect(assessment).toMatchObject({ state: 'OUTCOME_INCONCLUSIVE', reason: 'ATTRIBUTION_UNAVAILABLE' });
        return { id: itemId, created: true };
      },
    });
    expect(result?.record).toEqual({ id: itemId, created: true });
    expect(writes).toBe(1);
  });
});
