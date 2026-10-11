/**
 * Block B2c - deterministic unit tests for the BO governance evidence verifier (fake repository, no database).
 * Every refusal reason, the exact 24-hour freshness boundary (on the database clock), and the modification chronology.
 */
import { describe, expect, it } from 'vitest';
import { computeGovernanceSubjectDigest, type GovernanceEvidenceRequest } from '@infinicus/handoff-contracts';
import type { InventoryPolicyEvaluation } from '@infinicus/database';
import { BoGovernanceEvidenceVerifier, INVENTORY_REORDER_POLICY_V1_0_0 as RS, INVENTORY_REORDER_POLICY_V1_MAX_EVIDENCE_AGE_MS as MAX_AGE, INVENTORY_POLICY_EVALUATION_INPUTS_SCHEMA } from '../src/index.js';

const T = '10000000-0000-4000-8000-000000000001'; const WS = '10000000-0000-4000-8000-000000000002'; const BIZ = '10000000-0000-4000-8000-000000000003';
const USER = '10000000-0000-4000-8000-000000000004'; const ITEM = '10000000-0000-4000-8000-000000000005'; const EV_ID = '10000000-0000-4000-8000-000000000006';
const iso = (ms: number) => new Date(ms).toISOString();
const NOW = Date.parse('2026-10-12T12:00:00.000Z');
const MODIFIED = iso(NOW - 60 * 60_000); // decision final one hour ago
const PARAMS = { reorderPoint: 180, reorderQuantity: 200 };
const SUBJECT = { actionType: { code: 'inventory_reorder_policy_update', schemaVersion: '1' }, target: { kind: 'inventory_item', id: ITEM }, finalParameters: PARAMS };
const DIGEST = computeGovernanceSubjectDigest(SUBJECT as never);

const evaluation = (over: Partial<InventoryPolicyEvaluation> = {}): InventoryPolicyEvaluation => ({
  id: EV_ID, tenantId: T, workspaceId: WS, businessId: BIZ, inventoryItemId: ITEM, warehouseId: null, dimension: 'COST', result: 'PASSED',
  subject: SUBJECT as never, subjectDigest: DIGEST, ruleSetVersion: RS.version,
  inputs: { schema: INVENTORY_POLICY_EVALUATION_INPUTS_SCHEMA, ruleSet: { id: 'inventory-reorder-policy', version: RS.version, parameters: {} }, snapshotDigest: 'sha256:abc' } as never,
  findings: [], evaluatedAt: iso(NOW - 30 * 60_000), requestedByUserId: USER, correlationId: T, ...over,
});
const verifierFor = (ev: InventoryPolicyEvaluation | null, databaseNow = iso(NOW)) => new BoGovernanceEvidenceVerifier({
  evaluations: { getByIdWithDatabaseNow: async () => { if (ev === null) { const e = new Error('nf'); e.name = 'NotFoundError'; throw e; } return { evaluation: ev, databaseNow }; } },
});
const request = (over: Partial<GovernanceEvidenceRequest> = {}): GovernanceEvidenceRequest => ({
  tenantId: T, workspaceId: WS, businessId: BIZ, actorUserId: USER, modifiedAt: MODIFIED, dimension: 'COST',
  evidenceRef: { kind: 'bo_inventory_policy_evaluation', id: EV_ID }, subject: { actionId: T, ...SUBJECT } as never, ...over,
});
const refused = async (v: BoGovernanceEvidenceVerifier, r: GovernanceEvidenceRequest, pattern: RegExp) => {
  const verdict = await v.verify(r);
  expect(verdict.status).toBe('REFUSED');
  expect((verdict as { reason: string }).reason).toMatch(pattern);
};

describe('BoGovernanceEvidenceVerifier', () => {
  it('VERIFIES a PASSED, in-scope, current evaluation of the exact subject and answers with the stored facts', async () => {
    const verdict = await verifierFor(evaluation()).verify(request());
    expect(verdict).toEqual({
      status: 'VERIFIED', dimension: 'COST', result: 'PASSED', evaluatedAt: iso(NOW - 30 * 60_000), evidenceRef: { kind: 'bo_inventory_policy_evaluation', id: EV_ID },
      authoritativeSource: { layer: 'BUSINESS_OPERATIONS', component: 'InventoryPolicyEvaluationService' }, sourceVersion: `${RS.version}|sha256:abc`,
    });
  });

  it('verifies each of the four evaluated dimensions and no other', async () => {
    for (const dimension of ['CONSTRAINTS', 'RESOURCE_REQUIREMENTS', 'COST', 'EXPECTED_OUTCOME'] as const) {
      expect((await verifierFor(evaluation({ dimension })).verify(request({ dimension }))).status).toBe('VERIFIED');
    }
    for (const dimension of ['REVERSIBILITY', 'SIMULATION', 'RISK', 'nonsense']) {
      await refused(verifierFor(evaluation({ dimension: dimension as never })), request({ dimension: dimension as never }), /not an evaluated dimension/);
    }
  });

  it('FAILED and INDETERMINATE are never verified', async () => {
    await refused(verifierFor(evaluation({ result: 'FAILED' })), request(), /result is FAILED/);
    await refused(verifierFor(evaluation({ result: 'INDETERMINATE' })), request(), /result is INDETERMINATE/);
    await refused(verifierFor(evaluation({ result: 'passed' as never })), request(), /only PASSED/);
  });

  it('a missing record, a wrong kind and a malformed reference are refused', async () => {
    await refused(verifierFor(null), request(), /no such evaluation record/);
    await refused(verifierFor(evaluation()), request({ evidenceRef: { kind: 'simulation_run', id: EV_ID } }), /unsupported evidence kind/);
    await refused(verifierFor(evaluation()), request({ evidenceRef: { kind: 'bo_inventory_policy_evaluation', id: 'run-1' } }), /lowercase UUID/);
  });

  it('a record outside the requested tenant, workspace or business is refused (even if a repository returned it)', async () => {
    const other = '20000000-0000-4000-8000-000000000009';
    await refused(verifierFor(evaluation({ tenantId: other })), request(), /outside the requested scope/);
    await refused(verifierFor(evaluation({ workspaceId: other })), request(), /outside the requested scope/);
    await refused(verifierFor(evaluation({ businessId: other })), request(), /outside the requested scope/);
    await refused(verifierFor(evaluation({ id: other })), request(), /outside the requested scope/);
  });

  it('a record for another dimension, item, action type, schema version or target is refused', async () => {
    await refused(verifierFor(evaluation({ dimension: 'CONSTRAINTS' })), request({ dimension: 'COST' }), /evaluates CONSTRAINTS, not COST/);
    await refused(verifierFor(evaluation({ inventoryItemId: BIZ })), request(), /different inventory item/);
    await refused(verifierFor(evaluation()), request({ subject: { ...SUBJECT, actionId: T, actionType: { code: 'other_action', schemaVersion: '1' } } as never }), /only inventory_reorder_policy_update@1/);
    await refused(verifierFor(evaluation()), request({ subject: { ...SUBJECT, actionId: T, actionType: { code: 'inventory_reorder_policy_update', schemaVersion: '2' } } as never }), /only inventory_reorder_policy_update@1/);
    await refused(verifierFor(evaluation()), request({ subject: { ...SUBJECT, actionId: T, target: { kind: 'warehouse', id: ITEM } } as never }), /inventory item identified by a lowercase UUID/);
    await refused(verifierFor(evaluation()), request({ subject: { ...SUBJECT, actionId: T, target: { kind: 'inventory_item', id: 'sku-1' } } as never }), /inventory item identified by a lowercase UUID/);
  });

  it('a record evaluated for different parameters (digest mismatch) is refused, whichever side differs', async () => {
    await refused(verifierFor(evaluation()), request({ subject: { ...SUBJECT, actionId: T, finalParameters: { reorderPoint: 181, reorderQuantity: 200 } } as never }), /subject digest mismatch/);
    await refused(verifierFor(evaluation({ subjectDigest: `sha256:${'0'.repeat(64)}` })), request(), /subject digest mismatch/);
    // a forged digest over a different stored subject is caught by the stored-subject comparison
    const other = { ...SUBJECT, finalParameters: { reorderPoint: 999, reorderQuantity: 1 } };
    await refused(verifierFor(evaluation({ subject: other as never })), request(), /stored subject differs/);
  });

  it('an unsupported or unapproved rule-set version is refused', async () => {
    for (const ruleSetVersion of ['inventory-reorder-policy/v0.1.0-DRAFT', 'inventory-reorder-policy/v2.0.0', 'rules-test-1']) {
      await refused(verifierFor(evaluation({ ruleSetVersion })), request(), /not approved and effective/);
    }
  });

  it('a record without the BO evaluator input envelope is refused (provenance)', async () => {
    await refused(verifierFor(evaluation({ inputs: {} as never })), request(), /BO evaluator input snapshot/);
    await refused(verifierFor(evaluation({ inputs: { schema: 'something-else/1' } as never })), request(), /BO evaluator input snapshot/);
    const wrongRuleSet = { schema: INVENTORY_POLICY_EVALUATION_INPUTS_SCHEMA, ruleSet: { id: 'inventory-reorder-policy', version: 'inventory-reorder-policy/v2.0.0' }, snapshotDigest: 'sha256:abc' };
    await refused(verifierFor(evaluation({ inputs: wrongRuleSet as never })), request(), /BO evaluator input snapshot/);
  });

  describe('freshness (database clock, rule-set maximum evidence age = 24 hours, inclusive)', () => {
    it('the maximum age is the single versioned constant of rule set v1.0.0', () => {
      expect(MAX_AGE).toBe(24 * 60 * 60 * 1000);
      expect(RS.maxEvidenceAgeMs).toBe(MAX_AGE);
    });
    const at = (ageMs: number) => evaluation({ evaluatedAt: iso(NOW - ageMs) });
    const wide = iso(NOW - 3 * 24 * 60 * 60_000); // decision long ago, so only freshness is under test
    it('just inside the boundary (24h - 1ms) verifies', async () => { expect((await verifierFor(at(MAX_AGE - 1)).verify(request({ modifiedAt: wide }))).status).toBe('VERIFIED'); });
    it('exactly at the boundary (24h) verifies', async () => { expect((await verifierFor(at(MAX_AGE)).verify(request({ modifiedAt: wide }))).status).toBe('VERIFIED'); });
    it('just outside the boundary (24h + 1ms) is refused as stale', async () => { await refused(verifierFor(at(MAX_AGE + 1)), request({ modifiedAt: wide }), /older than the maximum evidence age/); });
    it('far outside is refused', async () => { await refused(verifierFor(at(72 * 60 * 60_000)), request({ modifiedAt: wide }), /older than the maximum evidence age/); });
    it('an evaluation dated after the database clock is refused', async () => { await refused(verifierFor(at(-1)), request(), /after the database clock/); });
    it('the age comes from the database clock, not the request', async () => {
      // same evaluation, database clock a day later: stale; a caller cannot move this
      await refused(verifierFor(evaluation(), iso(NOW + MAX_AGE + 30 * 60_000 + 1)), request({ modifiedAt: wide }), /older than the maximum evidence age/);
    });
  });

  describe('modification chronology (modifiedAt = the decision final time supplied by ABA)', () => {
    it('an evaluation BEFORE the modification decision is refused', async () => {
      await refused(verifierFor(evaluation({ evaluatedAt: iso(NOW - 61 * 60_000) })), request(), /predates the modification decision/);
      await refused(verifierFor(evaluation({ evaluatedAt: iso(Date.parse(MODIFIED) - 1) })), request(), /predates the modification decision/);
    });
    it('an evaluation exactly AT the modification time verifies (millisecond equality is canonical)', async () => {
      expect((await verifierFor(evaluation({ evaluatedAt: MODIFIED })).verify(request())).status).toBe('VERIFIED');
    });
    it('an evaluation after the modification verifies', async () => {
      expect((await verifierFor(evaluation({ evaluatedAt: iso(Date.parse(MODIFIED) + 1) })).verify(request())).status).toBe('VERIFIED');
    });
    it('a missing or malformed modifiedAt is refused (it can never be defaulted)', async () => {
      for (const modifiedAt of [undefined, '', 'yesterday', '2026-10-12T11:00:00Z', '2026-10-12 11:00:00.000']) {
        await refused(verifierFor(evaluation()), request({ modifiedAt: modifiedAt as never }), /modifiedAt must be a millisecond UTC timestamp/);
      }
    });
  });

  it('an unexpected repository error becomes REFUSED, never VERIFIED and never an escape', async () => {
    const boom = new BoGovernanceEvidenceVerifier({ evaluations: { getByIdWithDatabaseNow: async () => { throw new Error('connection reset'); } } });
    const verdict = await boom.verify(request());
    expect(verdict.status).toBe('REFUSED');
  });

  it('malformed requests are refused', async () => {
    const v = verifierFor(evaluation());
    for (const r of [null, undefined, {}, { ...request(), subject: undefined }, { ...request(), evidenceRef: undefined }, { ...request(), tenantId: 'x' }, { ...request(), actorUserId: undefined }]) {
      expect((await v.verify(r as never)).status).toBe('REFUSED');
    }
  });
});
