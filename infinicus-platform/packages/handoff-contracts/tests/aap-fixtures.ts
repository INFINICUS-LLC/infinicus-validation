// Fixtures for the AuthorizedActionPackage contract tests. The action type here is a TEST fixture only: the real
// action vocabulary is ABA-governed and is not defined by this block.
import { InMemoryActionTypeRegistry } from '../src';
import type { ActionTypeContract, AuthorizedActionPackageBody } from '../src';

export const ID = {
  package: '11111111-0000-4000-8000-000000000001',
  tenant: '22222222-0000-4000-8000-000000000001',
  workspace: '22222222-0000-4000-8000-000000000002',
  business: '22222222-0000-4000-8000-000000000003',
  action: '33333333-0000-4000-8000-000000000001',
  actionVersion: '33333333-0000-4000-8000-000000000002',
  recommendation: '44444444-0000-4000-8000-000000000001',
  recommendationVersion: '44444444-0000-4000-8000-000000000002',
  review: '44444444-0000-4000-8000-000000000003',
  reviewVersion: '44444444-0000-4000-8000-000000000004',
  decision: '55555555-0000-4000-8000-000000000001',
  decisionVersion: '55555555-0000-4000-8000-000000000002',
  twin: '66666666-0000-4000-8000-000000000001',
  simulation: '66666666-0000-4000-8000-000000000002',
  approver: '77777777-0000-4000-8000-000000000001',
  assignment: '77777777-0000-4000-8000-000000000002',
  assignmentVersion: '77777777-0000-4000-8000-000000000003',
  scope: '77777777-0000-4000-8000-000000000004',
  owner: '88888888-0000-4000-8000-000000000001',
  membership: '88888888-0000-4000-8000-000000000002',
  assigner: '88888888-0000-4000-8000-000000000003',
  ownerAssignment: '88888888-0000-4000-8000-000000000004',
  policy: '99999999-0000-4000-8000-000000000001',
  policyVersion: '99999999-0000-4000-8000-000000000002',
  causation: 'aaaaaaaa-0000-4000-8000-000000000001',
  auditEvent: 'aaaaaaaa-0000-4000-8000-000000000002',
  evidence: 'bbbbbbbb-0000-4000-8000-000000000001',
  rule: 'cccccccc-0000-4000-8000-000000000001',
  ruleVersion: 'cccccccc-0000-4000-8000-000000000002',
  governanceAudit: 'cccccccc-0000-4000-8000-000000000003',
  otherPackage: '11111111-0000-4000-8000-000000000009',
  otherTenant: '22222222-0000-4000-8000-0000000000ff',
};

export const T = {
  assigned: '2026-10-08T08:00:00.000Z',
  modified: '2026-10-08T08:30:00.000Z',
  evaluated: '2026-10-08T08:45:00.000Z',
  decided: '2026-10-08T09:00:00.000Z',
  assessed: '2026-10-08T09:59:00.000Z',
  issued: '2026-10-08T10:00:00.000Z',
  windowStart: '2026-10-08T10:05:00.000Z',
  windowEnd: '2026-10-08T12:00:00.000Z',
  validUntil: '2026-10-08T13:00:00.000Z',
  nowOk: '2026-10-08T10:10:00.000Z',
};

export const ADJUST_PRICE: ActionTypeContract = {
  code: 'adjust_price',
  schemaVersion: '1',
  targetKinds: ['product'],
  parameters: {
    sku: { type: 'identifier', required: true },
    newPrice: { type: 'decimal_string', required: true },
    note: { type: 'string', required: false, maxLength: 200 },
  },
  governanceImpact: {
    newPrice: ['COST', 'RISK', 'EXPECTED_OUTCOME'],
    note: [],
    // `sku` is deliberately NOT mapped: unknown impact => conservative full re-evaluation (R-7).
  },
  applicability: { executionWindow: 'NOT_APPLICABLE_ALLOWED', preconditions: 'NOT_APPLICABLE_ALLOWED', budget: 'NOT_APPLICABLE_ALLOWED', monitoring: 'NOT_APPLICABLE_ALLOWED' },
  // rollback is not listed => REQUIRED
};

/** An action schema that EXPLICITLY allows a package with no validity bound (expiry NOT_APPLICABLE). */
export const ADJUST_PRICE_UNBOUNDED: ActionTypeContract = {
  ...ADJUST_PRICE,
  code: 'adjust_price_unbounded',
  applicability: { ...ADJUST_PRICE.applicability, validityBound: 'NOT_APPLICABLE_ALLOWED' },
};

export const registry = (): InMemoryActionTypeRegistry => new InMemoryActionTypeRegistry([ADJUST_PRICE, ADJUST_PRICE_UNBOUNDED]);

export const na = (code: string, statement = 'governed test reason') => ({ state: 'NOT_APPLICABLE' as const, reason: { code, statement } });
export const val = <V>(value: V) => ({ state: 'VALUE' as const, value });

/** A plain approved package body (no modification). Deep-cloned so tests can mutate freely. */
export function approvedBody(): AuthorizedActionPackageBody {
  const parameters = { sku: 'SKU-100', newPrice: '10.00' };
  return JSON.parse(JSON.stringify({
    contractVersion: 'aap/1',
    identity: { packageId: ID.package, packageVersion: 1, supersedes: null },
    scope: { tenantId: ID.tenant, workspaceId: ID.workspace, businessId: ID.business },
    issuance: { issuedAt: T.issued, issuerComponent: 'aba.package-issuer' },
    action: {
      actionId: ID.action, actionVersionId: ID.actionVersion,
      type: { code: 'adjust_price', schemaVersion: '1' },
      target: { kind: 'product', id: 'SKU-100' },
      parameters,
      automationLevel: { level: 2, policy: { policyId: ID.policy, policyVersionId: ID.policyVersion } },
      executionWindow: val({ startsAt: T.windowStart, endsAt: T.windowEnd }),
      preconditions: val([{ code: 'stock_available', operator: 'gte', operand: 1 }]),
      budget: na('NO_SPEND', 'a price change spends nothing'),
      rollback: val({ instructions: 'Restore the previous price from the price history.' }),
      monitoring: val({ metrics: [{ metricCode: 'units_sold', target: null, unit: 'units' }] }),
    },
    lineage: {
      recommendation: { recommendationId: ID.recommendation, recommendationVersionId: ID.recommendationVersion },
      review: { reviewPackageId: ID.review, reviewVersionId: ID.reviewVersion },
      decision: { decisionId: ID.decision, decisionVersionId: ID.decisionVersion },
      twinSnapshotId: val(ID.twin),
      simulationRunId: na('NOT_SIMULATION_BACKED', 'decision was not simulation-backed'),
      proposedParameters: val({ source: { layer: 'ADI', recordType: 'decision_recommendation_version', recordId: ID.recommendationVersion }, parameters }),
      modification: na('NO_MODIFICATION', 'approved as recommended'),
      modificationEvaluation: na('NO_MODIFICATION', 'approved as recommended'),
    },
    authorization: {
      mode: 'HUMAN_APPROVAL',
      decisionStatus: 'approved',
      decidedAt: T.decided,
      approver: { userId: ID.approver, assignmentId: ID.assignment, assignmentVersionId: ID.assignmentVersion, roleCode: 'business-owner' },
      authorityProvenance: { scopeId: ID.scope },
      permissionUsed: 'aba:write',
      approvalAuditEventId: ID.auditEvent,
      risk: { riskClass: 'medium', basis: 'PERSISTED', requiredApproverTier: 2, approverTier: 3 },
    },
    accountableOwner: {
      identity: { userId: ID.owner, membershipId: ID.membership },
      roleCode: 'manager',
      assignment: { assignmentId: ID.ownerAssignment, assignedByUserId: ID.assigner, assignedAt: T.assigned },
      dueAt: na('NO_DUE_DATE'),
      escalationPolicy: na('NO_ESCALATION_POLICY'),
    },
    validity: {
      isTimeSensitive: true,
      decisionValidUntil: val(T.validUntil),
      freshness: { assessedAt: T.assessed, twin: 'FRESH' },
      expiryBounds: [
        { source: 'DECISION_VALID_UNTIL', at: T.validUntil },
        { source: 'EXECUTION_WINDOW_END', at: T.windowEnd },
      ],
      expiresAt: val(T.windowEnd),
    },
    consumption: { mode: 'SINGLE_USE' },
    trace: { correlationId: 'corr-aap-1', causationId: ID.causation },
  }));
}

/** An approve_with_modifications body: the approver changed newPrice 10.00 -> 9.50, with fresh evaluations. */
export function modifiedBody(): AuthorizedActionPackageBody {
  const b = approvedBody() as unknown as Record<string, any>;
  const original = { sku: 'SKU-100', newPrice: '10.00' };
  b.action.parameters = { sku: 'SKU-100', newPrice: '9.50' };
  b.authorization.decisionStatus = 'approved_with_modifications';
  b.lineage.proposedParameters = val({ source: { layer: 'ADI', recordType: 'decision_recommendation_version', recordId: ID.recommendationVersion }, parameters: original });
  b.lineage.modification = val({
    reason: 'Margin floor',
    modifiedByUserId: ID.approver,
    modifiedAt: T.modified,
    changes: [{ parameter: 'newPrice', operation: 'SET', before: '10.00', after: '9.50' }],
  });
  b.lineage.modificationEvaluation = val({
    basis: 'DECLARED_IMPACT',
    evidence: ['COST', 'RISK', 'EXPECTED_OUTCOME'].map((dimension) => ({ dimension, evaluatedAt: T.evaluated, result: 'PASSED', evidenceRef: { kind: 'evaluation', id: ID.evidence } })),
  });
  return b as AuthorizedActionPackageBody;
}

export const clone = <V>(v: V): V => JSON.parse(JSON.stringify(v));

/** A Level-3 rule-authorized package: no human approver, no human permissionUsed, no human modification. */
export function ruleBody(): AuthorizedActionPackageBody {
  const b = approvedBody() as unknown as Record<string, any>;
  b.action.automationLevel.level = 3;
  b.authorization = {
    mode: 'RULE_AUTHORIZED',
    policy: { policyId: ID.policy, policyVersionId: ID.policyVersion },
    rule: val({ ruleId: ID.rule, ruleVersionId: ID.ruleVersion }),
    evaluatedAt: T.decided,
    servicePrincipal: val({ principalId: 'svc-aba-rule-engine', component: 'aba.rule-evaluator' }),
    governanceAuditEventId: ID.governanceAudit,
    risk: { riskClass: 'medium', basis: 'PERSISTED' },
  };
  return b as AuthorizedActionPackageBody;
}

/** A package whose action schema allows (and which declares) no validity bound: expiry NOT_APPLICABLE with a schema basis. */
export function unboundedBody(): AuthorizedActionPackageBody {
  const b = approvedBody() as unknown as Record<string, any>;
  b.action.type.code = 'adjust_price_unbounded';
  b.validity.isTimeSensitive = false;
  b.validity.decisionValidUntil = na('NOT_TIME_SENSITIVE', 'ADI evaluated the recommendation as not time-sensitive');
  b.action.executionWindow = val({ startsAt: T.windowStart, endsAt: null });
  b.validity.expiryBounds = [];
  b.validity.expiresAt = {
    state: 'NOT_APPLICABLE',
    reason: { code: 'NO_VALIDITY_BOUND', statement: 'the action schema declares that no validity bound applies', basis: { kind: 'ACTION_SCHEMA', ref: 'adjust_price_unbounded@1' } },
  };
  return b as AuthorizedActionPackageBody;
}
