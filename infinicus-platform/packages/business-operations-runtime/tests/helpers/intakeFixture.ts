/**
 * Test-only builders for the P0-5 Block 3e BO intake tests. Packages are sealed here with the shared contract (tests may; production
 * BO code may not), with time-relative fields so they are valid against the real database clock.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- fixtures build and mutate arbitrary JSON documents */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { canonicalActionTypeRegistry, sealAuthorizedActionPackage } from '@infinicus/handoff-contracts';
import type { AuthoritativeStatusAnswer, AuthorizedActionPackageV1 } from '@infinicus/handoff-contracts';

export const MIN = 60_000;
export const iso = (ms: number): string => new Date(ms).toISOString();
export const val = <V>(value: V) => ({ state: 'VALUE' as const, value });
export const na = (code: string) => ({ state: 'NOT_APPLICABLE' as const, reason: { code, statement: 'governed test reason' } });

export interface World { tenantId: string; workspaceId: string; businessId: string; otherBusinessId: string }

export async function makeWorld(admin: Pool): Promise<World> {
  const w: World = { tenantId: randomUUID(), workspaceId: randomUUID(), businessId: randomUUID(), otherBusinessId: randomUUID() };
  const slug = `t${w.tenantId.slice(0, 8)}`;
  const c = await admin.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL session_replication_role = 'replica'");
    await c.query('INSERT INTO tenancy.tenants (id, name, slug) VALUES ($1,$2,$3)', [w.tenantId, slug, slug]);
    await c.query('INSERT INTO tenancy.workspaces (id, tenant_id, name, slug) VALUES ($1,$2,$3,$4)', [w.workspaceId, w.tenantId, slug, slug]);
    for (const [id, code] of [[w.businessId, slug], [w.otherBusinessId, `${slug}x`]]) {
      await c.query('INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code) VALUES ($1,$2,$3,$4,$5)', [id, w.tenantId, w.workspaceId, code, code]);
    }
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
  return w;
}

export interface BodyOptions {
  packageId?: string;
  version?: number;
  scope?: { tenantId: string; workspaceId: string; businessId: string };
  /** Milliseconds relative to now. */
  issuedOffset?: number;
  windowStartOffset?: number;
  windowEndOffset?: number;
  parameters?: Record<string, number>;
  supersedes?: { packageId: string; packageVersion: number };
}

/** A sealed Level 2 package for the canonical inventory_reorder_policy_update@1 type. */
export function sealedPackage(world: World, o: BodyOptions = {}): AuthorizedActionPackageV1 {
  const now = Date.now();
  const at = (offset: number): string => iso(now + offset);
  const issued = o.issuedOffset ?? -5 * MIN;
  const windowStart = o.windowStartOffset ?? -2 * MIN;
  const windowEnd = o.windowEndOffset ?? 60 * MIN;
  const parameters = o.parameters ?? { reorderPoint: 10, reorderQuantity: 50 };
  const body: any = {
    contractVersion: 'aap/1',
    identity: { packageId: o.packageId ?? randomUUID(), packageVersion: o.version ?? 1, supersedes: o.supersedes ?? null },
    scope: o.scope ?? { tenantId: world.tenantId, workspaceId: world.workspaceId, businessId: world.businessId },
    issuance: { issuedAt: at(issued), issuerComponent: 'aba.package-issuer' },
    action: {
      actionId: randomUUID(), actionVersionId: randomUUID(),
      type: { code: 'inventory_reorder_policy_update', schemaVersion: '1' },
      target: { kind: 'inventory_item', id: 'sku-123' },
      parameters,
      automationLevel: { level: 2, policy: { policyId: randomUUID(), policyVersionId: randomUUID() } },
      executionWindow: val({ startsAt: at(windowStart), endsAt: at(windowEnd) }),
      preconditions: val([{ code: 'stock_available', operator: 'gte', operand: 1 }]),
      budget: val({ amount: '250.00', currency: 'USD' }),
      rollback: val({ instructions: 'Restore the previous reorder policy.' }),
      monitoring: val({ metrics: [{ metricCode: 'stockouts', target: 0, unit: 'count' }] }),
    },
    lineage: {
      recommendation: { recommendationId: randomUUID(), recommendationVersionId: randomUUID() },
      review: { reviewPackageId: randomUUID(), reviewVersionId: randomUUID() },
      decision: { decisionId: randomUUID(), decisionVersionId: randomUUID() },
      twinSnapshotId: na('NO_TWIN_SNAPSHOT'),
      simulationRunId: val(randomUUID()),
      proposedParameters: val({ source: { layer: 'ADI', recordType: 'decision_recommendation_version', recordId: randomUUID() }, parameters }),
      modification: na('PLAIN_APPROVAL'),
      modificationEvaluation: na('NO_MODIFICATION'),
    },
    authorization: {
      mode: 'HUMAN_APPROVAL', decisionStatus: 'approved', decidedAt: at(issued - 3 * MIN),
      approver: { userId: randomUUID(), assignmentId: randomUUID(), assignmentVersionId: randomUUID(), roleCode: 'business-owner' },
      authorityProvenance: { scopeId: randomUUID() }, permissionUsed: 'aba:approve', approvalAuditEventId: randomUUID(),
      risk: { riskClass: 'low', basis: 'PERSISTED', requiredApproverTier: 1, approverTier: 3 },
    },
    accountableOwner: {
      identity: { userId: randomUUID(), membershipId: randomUUID() }, roleCode: 'operations_lead',
      assignment: { assignmentId: randomUUID(), assignedByUserId: randomUUID(), assignedAt: at(issued - 4 * MIN) },
      dueAt: na('NO_DUE_DATE'), escalationPolicy: na('NO_ESCALATION_POLICY'),
    },
    validity: {
      isTimeSensitive: true,
      decisionValidUntil: val(at(windowEnd + 60 * MIN)),
      freshness: { assessedAt: at(issued - MIN), twin: 'NOT_APPLICABLE' },
      expiryBounds: [{ source: 'DECISION_VALID_UNTIL', at: at(windowEnd + 60 * MIN) }, { source: 'EXECUTION_WINDOW_END', at: at(windowEnd) }],
      expiresAt: val(at(windowEnd)),
    },
    consumption: { mode: 'SINGLE_USE' },
    trace: { correlationId: randomUUID(), causationId: randomUUID() },
  };
  return sealAuthorizedActionPackage(body, { actionTypes: canonicalActionTypeRegistry() });
}

/** A status answer about `pkg`. Overrides replace whole `status` / `authority` fields. */
export function answerFor(pkg: AuthorizedActionPackageV1, over: { status?: Partial<AuthoritativeStatusAnswer['status']>; authority?: Partial<AuthoritativeStatusAnswer['authority']> } = {}): AuthoritativeStatusAnswer {
  const verifiedAt = iso(Date.now() - 300);
  return {
    status: {
      packageId: pkg.identity.packageId, packageVersion: pkg.identity.packageVersion, digest: pkg.integrity.digest,
      lifecycle: 'ISSUED', latestPackageVersion: pkg.identity.packageVersion, verifiedAt, ...over.status,
    },
    authority: { state: 'CURRENT', verifiedAt, ...over.authority },
  };
}
