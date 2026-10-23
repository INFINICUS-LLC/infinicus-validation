import { describe, expect, it } from 'vitest';
import type { ActionExecutionVerification, GovernedMeasurementDefinition, TenantContext } from '@infinicus/database';
import { assessVerificationRefusal, type VerificationCandidate, type VerificationRefusalReason } from '../src/VerificationRefusalAssessment.js';

const ids = Array.from({ length: 12 }, (_, n) => {
  const digit = (n + 1).toString(16);
  return `${digit.repeat(8)}-1111-4111-8111-${digit.repeat(12)}`;
});
const [tenant, workspace, business, verificationId, executionId, author, approver, executor, observer, observationVersion, assessor, definitionId] = ids;
const digest = `sha256:${'a'.repeat(64)}`;
const ctx: TenantContext = { tenantId: tenant, workspaceId: workspace, userId: approver };

function candidate(): VerificationCandidate {
  return {
    businessId: business, executorId: executor,
    execution: { id: verificationId, executionId, tenantId: tenant, workspaceId: workspace, businessId: business,
      evidenceDigest: digest, executionState: 'EXECUTION_VERIFIED', executionOutcome: 'SUCCEEDED', mutationResult: 'APPLIED',
      executionRecordedAt: '2026-10-01T00:00:00.000Z', actionType: { code: 'inventory_reorder_policy_update', schemaVersion: '1' } } as ActionExecutionVerification,
    definition: { id: definitionId, businessId: business, actionTypeCode: 'inventory_reorder_policy_update', actionTypeSchemaVersion: '1',
      metricCode: 'NET_SALES_REVENUE_V1', windowSeconds: 604800, baselineSeconds: 604800,
      successThreshold: '10', successDirection: 'increase',
      authorId: author, approverId: approver } as GovernedMeasurementDefinition,
    metricApproved: true, criterionApproved: true,
    baseline: { complete: true, businessId: business, currency: 'USD', metricCode: 'NET_SALES_REVENUE_V1', metricVersion: 1,
      openedAt: '2026-09-24T00:00:00.000Z', closedAt: '2026-10-01T00:00:00.000Z' },
    window: { openedAt: '2026-10-01T00:00:00.000Z', closedAt: '2026-10-08T00:00:00.000Z' },
    observation: { id: observer, versionId: observationVersion, businessId: business, currency: 'USD',
      metricCode: 'NET_SALES_REVENUE_V1', metricVersion: 1, writerAuthorized: true, sourceDigest: digest, provenanceValid: true },
    attribution: { status: 'PASS', sourceDigest: digest, assessorId: assessor, version: 1 },
    approval: { userId: approver, businessId: business, authorityConfirmed: true },
    evaluatedAt: '2026-10-08T00:00:01.000Z',
  };
}

const reasons = (input: VerificationCandidate): readonly VerificationRefusalReason[] => {
  const result = assessVerificationRefusal(ctx, input);
  expect(result.verdictAllowed).toBe(false);
  return result.reasons;
};

describe('OM-MEASURE-7 refusal assessment', () => {
  it('never grants a positive verdict even when all advisory candidate fields look valid', () => {
    expect(reasons(candidate())).toEqual(['OBSERVATION_AUTHORITY_PENDING']);
  });

  it.each([
    ['missing execution', (c: VerificationCandidate) => { c.execution = null; }, 'EXECUTION_EVIDENCE_MISSING'],
    ['unapplied execution', (c: VerificationCandidate) => { c.execution!.mutationResult = 'NO_CHANGE'; }, 'EXECUTION_NOT_APPLIED'],
    ['foreign tenant', (c: VerificationCandidate) => { c.execution!.tenantId = author; }, 'SCOPE_MISMATCH'],
    ['foreign workspace', (c: VerificationCandidate) => { c.execution!.workspaceId = author; }, 'SCOPE_MISMATCH'],
    ['foreign business', (c: VerificationCandidate) => { c.execution!.businessId = author; }, 'SCOPE_MISMATCH'],
    ['unknown metric', (c: VerificationCandidate) => { c.metricApproved = false; }, 'METRIC_UNAPPROVED'],
    ['absent baseline', (c: VerificationCandidate) => { c.baseline = null; }, 'BASELINE_INCOMPLETE'],
    ['non-equivalent baseline', (c: VerificationCandidate) => { c.baseline!.closedAt = '2026-09-30T00:00:00.000Z'; }, 'BASELINE_INCOMPLETE'],
    ['open window', (c: VerificationCandidate) => { c.evaluatedAt = '2026-10-07T00:00:00.000Z'; }, 'WINDOW_INCOMPLETE'],
    ['local-time window', (c: VerificationCandidate) => { c.window!.openedAt = '2026-10-01T00:00:00+02:00'; }, 'WINDOW_INCOMPLETE'],
    ['unauthorized observation writer', (c: VerificationCandidate) => { c.observation!.writerAuthorized = false; }, 'OBSERVATION_UNAUTHORIZED'],
    ['bad provenance', (c: VerificationCandidate) => { c.observation!.sourceDigest = 'bad'; }, 'PROVENANCE_INVALID'],
    ['different currency', (c: VerificationCandidate) => { c.observation!.currency = 'EUR'; }, 'CURRENCY_MISMATCH'],
    ['failed attribution', (c: VerificationCandidate) => { c.attribution!.status = 'FAIL'; }, 'ATTRIBUTION_NOT_PASSED'],
    ['unauthorized approver', (c: VerificationCandidate) => { c.approval!.authorityConfirmed = false; }, 'APPROVER_UNAUTHORIZED'],
    ['foreign-business approver', (c: VerificationCandidate) => { c.approval!.businessId = author; }, 'APPROVER_UNAUTHORIZED'],
    ['definition author approves', (c: VerificationCandidate) => { c.approval!.userId = author; }, 'SELF_APPROVAL'],
    ['self approval', (c: VerificationCandidate) => { c.executorId = approver; }, 'SELF_APPROVAL'],
    ['unknown executor', (c: VerificationCandidate) => { c.executorId = null; }, 'SELF_APPROVAL'],
    ['unapproved criterion', (c: VerificationCandidate) => { c.criterionApproved = false; }, 'CRITERION_UNAPPROVED'],
  ] as const)('refuses %s', (_label, mutate, reason) => {
    const input = candidate(); mutate(input);
    expect(reasons(input)).toContain(reason);
    expect(reasons(input)).toContain('OBSERVATION_AUTHORITY_PENDING');
  });

  it('does not trust a changed scope, definition, or attribution result', () => {
    const input = candidate();
    input.approval!.businessId = author;
    input.definition!.actionTypeCode = 'other';
    input.attribution!.status = 'INCONCLUSIVE';
    expect(reasons(input)).toEqual(expect.arrayContaining(['METRIC_UNAPPROVED', 'ATTRIBUTION_NOT_PASSED', 'APPROVER_UNAUTHORIZED']));
  });
});
