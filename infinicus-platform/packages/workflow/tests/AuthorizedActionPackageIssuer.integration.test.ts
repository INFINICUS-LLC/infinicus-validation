/**
 * P0-5 Block 3d - live PostgreSQL proof of the ABA package issuer.
 *
 * Requires DATABASE_URL (least-privilege app role, RLS enforced) and ADMIN_DATABASE_URL (fixtures / inspection).
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- tests mutate arbitrary JSON documents */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  AuthorizedActionBoundaryRepository, AuthorizedActionIssuanceRepository, AutomationLevelPolicyRepository, AuthorizedActionPackageRepository, closePool, createPool,
  type TenantContext,
} from '@infinicus/database';
import {
  INVENTORY_REORDER_POLICY_UPDATE_V1, InMemoryActionTypeRegistry, validateAuthorizedActionPackage,
} from '@infinicus/handoff-contracts';
import type { ActionTypeContract } from '@infinicus/handoff-contracts';
import {
  AuthorizedActionPackageIssuer, ISSUANCE_ENABLEMENT, PackageIssuanceRefusedError, type IssuanceRefusalCode,
} from '../src/index.js';
import { G, HOUR, NA, S, iso, makeIssuable, makeWorld, type FixtureOptions, type IssuableFixture } from './helpers/issuanceFixture.js';

const run = Boolean(process.env.DATABASE_URL && process.env.ADMIN_DATABASE_URL);
let admin: Pool;
const issuer = new AuthorizedActionPackageIssuer();
const packages = new AuthorizedActionPackageRepository();

const fresh = async (o: FixtureOptions = {}): Promise<IssuableFixture> => makeIssuable(admin, await makeWorld(admin), o);
const request = (f: IssuableFixture) => ({ actionId: f.actionId });
const count = async (sql: string, params: unknown[]): Promise<number> => Number((await admin.query(sql, params)).rows[0].n);
const versions = (f: IssuableFixture) => count(`SELECT count(*) n FROM ${S}.authorized_action_package_versions WHERE business_id=$1`, [f.businessId]);
const headers = (f: IssuableFixture) => count(`SELECT count(*) n FROM ${S}.authorized_action_packages WHERE business_id=$1`, [f.businessId]);
const audits = (f: IssuableFixture, type: string) => count(`SELECT count(*) n FROM ${S}.approval_audit_events WHERE business_id=$1 AND event_type=$2`, [f.businessId, type]);

async function refusal(f: IssuableFixture, issuerUnderTest = issuer): Promise<PackageIssuanceRefusedError> {
  try {
    await issuerUnderTest.issue(f.ctx, request(f));
  } catch (e) {
    expect(e).toBeInstanceOf(PackageIssuanceRefusedError);
    return e as PackageIssuanceRefusedError;
  }
  throw new Error('expected the issuance to be refused');
}

/** A canonical contract that explicitly allows governed fields (and the validity bound) to be NOT_APPLICABLE. */
const FLEXIBLE: ActionTypeContract = {
  ...INVENTORY_REORDER_POLICY_UPDATE_V1,
  applicability: { executionWindow: 'NOT_APPLICABLE_ALLOWED', preconditions: 'NOT_APPLICABLE_ALLOWED', budget: 'NOT_APPLICABLE_ALLOWED', rollback: 'NOT_APPLICABLE_ALLOWED', monitoring: 'NOT_APPLICABLE_ALLOWED', validityBound: 'NOT_APPLICABLE_ALLOWED' },
};
const flexibleIssuer = new AuthorizedActionPackageIssuer({ canonicalTypes: new InMemoryActionTypeRegistry([FLEXIBLE]) });

describe.runIf(run)('P0-5 Block 3d: ABA package issuer', () => {
  beforeAll(() => {
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    createPool({ connectionString: process.env.DATABASE_URL as string });
  });
  afterAll(async () => {
    await admin?.end();
    await closePool();
  });

  describe('issuance', () => {
    it('issues a plain approved Level 2 package from persisted facts only', async () => {
      const f = await fresh();
      const r = await issuer.issue(f.ctx, request(f));
      expect(r.outcome).toBe('ISSUED');
      const p: any = r.package;
      expect(validateAuthorizedActionPackage(p, { actionTypes: new InMemoryActionTypeRegistry([INVENTORY_REORDER_POLICY_UPDATE_V1]), enablement: ISSUANCE_ENABLEMENT }).valid).toBe(true);
      expect(p.action.type).toEqual({ code: 'inventory_reorder_policy_update', schemaVersion: '1' });
      expect(p.action.target).toEqual({ kind: 'inventory_item', id: 'sku-123' });
      expect(p.action.parameters).toEqual({ reorderPoint: 10, reorderQuantity: 50 });
      expect(p.action.automationLevel.level).toBe(2);
      expect(p.authorization).toMatchObject({
        mode: 'HUMAN_APPROVAL', decisionStatus: 'approved', permissionUsed: 'aba:approve', approvalAuditEventId: f.approvalAuditEventId,
        approver: { userId: f.approverUserId, assignmentId: f.assignmentId, assignmentVersionId: f.assignmentVersionId, roleCode: 'business-owner' },
        authorityProvenance: { scopeId: f.grantScopeId }, risk: { riskClass: 'medium', basis: 'PERSISTED', requiredApproverTier: 2, approverTier: 3 },
      });
      expect(Date.parse(p.authorization.decidedAt)).toBe(f.decidedAt.getTime());
      expect(p.lineage.recommendation).toEqual({ recommendationId: f.recommendationId, recommendationVersionId: f.recommendationVersionId });
      expect(p.lineage.review).toEqual({ reviewPackageId: f.reviewPackageId, reviewVersionId: f.reviewVersionId });
      expect(p.lineage.decision).toEqual({ decisionId: f.decisionId, decisionVersionId: f.decisionVersionId });
      expect(p.trace.causationId).toBe(f.approvalAuditEventId);
      expect(p.issuance.issuerComponent).toBe('aba.package-issuer');
      expect(p.accountableOwner.identity.userId).toBe(f.ownerUserId);
      expect(r.record.digest).toBe(p.integrity.digest);
      expect(await versions(f)).toBe(1);
      const lifecycle = await packages.listLifecycle(f.ctx, p.identity.packageId, 1);
      expect(lifecycle.map((e) => e.state)).toEqual(['ISSUED']);
    });

    it('issues an approved-with-modifications package using the DB-derived final parameters', async () => {
      const f = await fresh({ modified: true });
      const r = await issuer.issue(f.ctx, request(f));
      const p: any = r.package;
      expect(p.authorization.decisionStatus).toBe('approved_with_modifications');
      expect(p.action.parameters).toEqual({ reorderPoint: 15, reorderQuantity: 60 });
      expect(p.lineage.proposedParameters.value.parameters).toEqual({ reorderPoint: 10, reorderQuantity: 50 });
      expect(p.lineage.modification.value.changes).toHaveLength(2);
      expect(p.lineage.modificationEvaluation.value.basis).toBe('DECLARED_IMPACT');
    });

    it('B2c: a NOT_APPLICABLE simulation for this type is accepted ONLY with the exact canonical reason NO_APPLICABLE_SIMULATION_MODEL', async () => {
      const ok = await fresh({ simulationRun: NA('NO_APPLICABLE_SIMULATION_MODEL', 'No Simulation model evaluates inventory reorder policy.') });
      const r: any = await new AuthorizedActionPackageIssuer().issue(ok.ctx, request(ok));
      expect(r.package.lineage.simulationRunId.state).toBe('NOT_APPLICABLE');
      expect(r.package.lineage.simulationRunId.reason.code).toBe('NO_APPLICABLE_SIMULATION_MODEL');
    });

    it('B2c: any other NOT_APPLICABLE reason for this type is refused (SIMULATION_REQUIRED), nothing is written', async () => {
      const f = await fresh({ simulationRun: NA('NOT_SIMULATION_BACKED', 'The decision was not simulation-backed.') });
      expect((await refusal(f)).codes).toEqual(['SIMULATION_REQUIRED']);
      expect(await versions(f)).toBe(0);
    });

    it('accepts a governed NOT_APPLICABLE simulation only for a canonical type that explicitly allows it (D-6, per type)', async () => {
      const f = await fresh({ contract: FLEXIBLE, simulationRun: NA('NO_APPLICABLE_SIMULATION_MODEL', 'No Simulation model applies.') });
      const allowing = new AuthorizedActionPackageIssuer({
        canonicalTypes: new InMemoryActionTypeRegistry([FLEXIBLE]), simulationNotApplicableAllowed: new Set(['inventory_reorder_policy_update@1']),
      });
      const r: any = await allowing.issue(f.ctx, request(f));
      expect(r.package.lineage.simulationRunId.state).toBe('NOT_APPLICABLE');
      expect(r.package.lineage.simulationRunId.reason.code).toBe('NO_APPLICABLE_SIMULATION_MODEL');
      // the same data is refused by an issuer whose canonical type does not allow it
      const notAllowing = new AuthorizedActionPackageIssuer({ canonicalTypes: new InMemoryActionTypeRegistry([FLEXIBLE]), simulationNotApplicableAllowed: new Set() });
      expect((await refusal(f, notAllowing)).codes).toEqual(['SIMULATION_REQUIRED']);
    });

    it('accepts governed NOT_APPLICABLE boundaries and an unbounded validity only where the canonical contract explicitly allows it', async () => {
      const f = await fresh({
        contract: FLEXIBLE, isTimeSensitive: false, validUntil: null,
        window: NA('NO_WINDOW', 'No window applies.'), budget: NA('NO_BUDGET', 'No budget applies.'),
        preconditions: NA('NO_PRECONDITIONS', 'None.'), rollback: NA('NO_ROLLBACK', 'None.'), monitoring: NA('NO_MONITORING', 'None.'),
      });
      const r: any = await flexibleIssuer.issue(f.ctx, request(f));
      expect(r.package.action.budget.state).toBe('NOT_APPLICABLE');
      expect(r.package.validity.expiresAt).toMatchObject({ state: 'NOT_APPLICABLE', reason: { code: 'NO_VALIDITY_BOUND', basis: { kind: 'ACTION_SCHEMA', ref: 'inventory_reorder_policy_update@1' } } });
      // the same data is refused under the production canonical contract (every field and the bound are REQUIRED there)
      const e = await refusal(f);
      expect(e.codes).toContain('ACTION_TYPE_DIVERGES_FROM_CANONICAL');
    });

    it('derives the authority lineage as of the decision: a later assignment version does not change it', async () => {
      const f = await fresh();
      await admin.query(
        `INSERT INTO ${S}.approver_assignment_versions (tenant_id, workspace_id, business_id, assignment_id, version_number, role_code, created_at)
         VALUES ($1,$2,$3,$4,2,'cashier',$5)`,
        [f.world.tenantId, f.world.workspaceId, f.businessId, f.assignmentId, new Date(f.decidedAt.getTime() + 1000)],
      );
      const r: any = await issuer.issue(f.ctx, request(f));
      expect(r.package.authorization.approver.assignmentVersionId).toBe(f.assignmentVersionId);
      expect(r.package.authorization.approver.roleCode).toBe('business-owner');
    });

    it('a bound from the execution window alone is enough (one authoritative validity bound suffices)', async () => {
      const f = await fresh({ isTimeSensitive: false, validUntil: null });
      const r: any = await issuer.issue(f.ctx, request(f));
      expect(r.package.validity.decisionValidUntil.state).toBe('NOT_APPLICABLE');
      expect(r.package.validity.expiryBounds.map((b: any) => b.source)).toEqual(['EXECUTION_WINDOW_END']);
      expect(r.package.validity.expiresAt.state).toBe('VALUE');
    });

    it('pins the action version for lineage only: its description never reaches the package and parameters come only from the capture (D3D-4)', async () => {
      const f = await fresh({ actionDescription: 'HOSTILE-DESCRIPTION reorderPoint=99999' });
      const r: any = await issuer.issue(f.ctx, request(f));
      expect(JSON.stringify(r.package)).not.toContain('HOSTILE-DESCRIPTION');
      expect(r.package.action.parameters).toEqual({ reorderPoint: 10, reorderQuantity: 50 });
      const pinned = (await admin.query(`SELECT id FROM ${S}.approved_action_versions WHERE action_id=$1 ORDER BY version_number DESC LIMIT 1`, [f.actionId])).rows[0].id;
      expect(r.package.action.actionVersionId).toBe(pinned);
    });

    it('ignores any caller-supplied authorization facts or final parameters (identifiers only)', async () => {
      const f = await fresh();
      const hostile: any = {
        actionId: f.actionId, finalParameters: { reorderPoint: 9999, reorderQuantity: 9999 }, parameters: { reorderPoint: 1 }, automationLevel: 4,
        riskClass: 'low', approverTier: 99, permissionUsed: 'root', decisionStatus: 'approved',
      };
      const r: any = await issuer.issue(f.ctx, hostile);
      expect(r.package.action.parameters).toEqual({ reorderPoint: 10, reorderQuantity: 50 });
      expect(r.package.action.automationLevel.level).toBe(2);
      expect(r.package.authorization.permissionUsed).toBe('aba:approve');
    });
  });

  describe('refusals', () => {
    const cases: [string, FixtureOptions, IssuanceRefusalCode][] = [
      ['no structured capture (approved but not issuable)', { omitCapture: true }, 'CAPTURE_MISSING'],
      ['a stored NOT_APPLICABLE reason code that is not UPPER_SNAKE_CASE (never normalized)', { capture: (c) => { c.modification = NA('plain_approval', 'Approved as proposed.'); } }, 'NOT_APPLICABLE_REASON_CODE_INVALID'],
      ['an action type that was never activated', { registration: 'draft', omitBoundaries: true }, 'ACTION_TYPE_NOT_ACTIVE'],
      ['a retired action type', { registration: 'retired' }, 'ACTION_TYPE_NOT_ACTIVE'],
      ['an action type with no workspace registration', { registration: 'none', omitBoundaries: true }, 'ACTION_TYPE_NOT_ACTIVE'],
      ['a workspace definition that redefines the canonical contract', { registryDivergence: (c) => { c.parameters.reorderPoint.min = 1; } }, 'ACTION_TYPE_DIVERGES_FROM_CANONICAL'],
      ['a workspace definition that loosens applicability', { registryDivergence: (c) => { c.applicability.budget = 'NOT_APPLICABLE_ALLOWED'; } }, 'ACTION_TYPE_DIVERGES_FROM_CANONICAL'],
      ['no enabled Level 2 policy', { enabledLevels: [] }, 'LEVEL2_POLICY_NOT_ENABLED'],
      ['a Level 2 policy that does not name the action type', { policySpecification: { actionTypes: [{ code: 'other', schemaVersion: '1' }] } }, 'LEVEL2_POLICY_NOT_ENABLED'],
      ['a Level 2 policy with no action-type scope', { policySpecification: null }, 'LEVEL2_POLICY_NOT_ENABLED'],
      ['authority revoked after the decision', { revokeAuthorityAfterDecision: true }, 'AUTHORITY_REVOKED'],
      ['no canonical authority grant', { noGrantProvenance: true }, 'AUTHORITY_NOT_ESTABLISHED'],
      ['authority granted only after the decision', { grantAfterDecision: true }, 'AUTHORITY_NOT_ESTABLISHED'],
      ['an insufficient risk tier (high risk, manager)', { riskClass: 'high', roleCode: 'manager' }, 'RISK_POLICY'],
      ['a recommendation risk (low) below the canonical base risk of the action type (medium), AC-2', { riskClass: 'low' }, 'RISK_POLICY'],
      ['an unclassified risk with a cashier', { riskClass: null, roleCode: 'cashier' }, 'RISK_POLICY'],
      ['a stale Digital Twin snapshot', { twin: 'stale' }, 'FRESHNESS_GATE'],
      ['an expired decision', { validUntil: new Date(Date.now() - 1000) }, 'FRESHNESS_GATE'],
      ['unknown time-sensitivity', { isTimeSensitive: null }, 'FRESHNESS_GATE'],
      ['no authoritative validity bound at all (no valid_until, open-ended window, no governed expiry) - never NOT_APPLICABLE (D3D-1)', { isTimeSensitive: false, validUntil: null, window: G({ startsAt: iso(new Date(Date.now() + HOUR)), endsAt: null }) }, 'VALIDITY_BOUND_REQUIRED'],
      ['a policy for schema version 2 only (a v1 action is not authorized by a v2 policy, D3D-2)', { policySpecification: { actionTypes: [{ code: 'inventory_reorder_policy_update', schemaVersion: '2' }] } }, 'LEVEL2_POLICY_NOT_ENABLED'],
      ['no accountable owner', { omitOwner: true }, 'OWNER_MISSING'],
      ['no execution boundaries / simulation reference', { omitBoundaries: true }, 'BOUNDARIES_MISSING'],
      ['no approval audit event', { omitAuditEvent: true }, 'APPROVAL_AUDIT_MISSING'],
      ['an approval audit event without the permission used', { permissionUsed: null }, 'APPROVAL_AUDIT_MISMATCH'],
    ];
    it.each(cases)('refuses: %s', async (_name, options, code) => {
      const f = await fresh(options);
      const e = await refusal(f);
      expect(e.codes).toContain(code);
      expect(await versions(f)).toBe(0);
      expect(await headers(f)).toBe(0);
    });

    it('a fresh Twin snapshot is accepted and recorded as FRESH', async () => {
      const f = await fresh({ twin: 'fresh' });
      const r: any = await issuer.issue(f.ctx, request(f));
      expect(r.package.lineage.twinSnapshotId).toEqual({ state: 'VALUE', value: f.twinSnapshotId });
      expect(r.package.validity.freshness.twin).toBe('FRESH');
    });

    it('invalid boundaries cannot be stored, so an action with only invalid boundaries has none and is refused', async () => {
      const f = await fresh({ omitBoundaries: true });
      await expect(new AuthorizedActionBoundaryRepository().recordBoundaries(f.ctx, {
        businessId: f.businessId, actionId: f.actionId, captureId: f.captureId as string,
        executionWindow: G({ startsAt: iso(new Date(Date.now() + 8 * HOUR)), endsAt: iso(new Date(Date.now() + HOUR)) }),
        preconditions: G([]), budget: G({ amount: '1.00', currency: 'USD' }), rollback: G({ instructions: 'x' }),
        monitoring: G({ metrics: [{ metricCode: 'm', target: 1, unit: 'u' }] }), simulationRun: G(randomUUID()),
        authoredByUserId: f.approverUserId, correlationId: randomUUID(),
      } as any)).rejects.toThrow();
      expect((await refusal(f)).codes).toContain('BOUNDARIES_MISSING');
    });

    it('Level 3 / Level 4 policies cannot even be enabled, so no Level 3/4 package has a policy source', async () => {
      const f = await fresh({ enabledLevels: [] });
      const policies = new AutomationLevelPolicyRepository();
      for (const level of [3, 4] as const) {
        const { version } = await policies.createPolicy(f.ctx, { policyCode: `l${level}_x`, automationLevel: level, description: 'x', specification: {}, createdByUserId: f.approverUserId, correlationId: randomUUID() });
        await expect(policies.enable(f.ctx, version.id, { actorUserId: f.approverUserId, reason: 'try', correlationId: randomUUID() })).rejects.toThrow(/only Level 2 can be enabled/);
      }
      expect((await refusal(f)).codes).toContain('LEVEL2_POLICY_NOT_ENABLED');
    });

    it('Level 3 and Level 4 are never issuable: the issuance enablement admits Level 2 only', async () => {
      const f = await fresh();
      const p: any = JSON.parse(JSON.stringify((await issuer.issue(f.ctx, request(f))).package));
      for (const level of [3, 4]) {
        p.action.automationLevel.level = level;
        const v = validateAuthorizedActionPackage(p, { actionTypes: new InMemoryActionTypeRegistry([INVENTORY_REORDER_POLICY_UPDATE_V1]), enablement: ISSUANCE_ENABLEMENT });
        expect(v.valid).toBe(false);
        expect(v.errors.map((e) => e.code)).toContain('AUTOMATION_LEVEL_NOT_ENABLED');
      }
    });

    it('an unknown action, or one in another tenant, is refused without leaking its existence', async () => {
      const f = await fresh();
      const other = await makeWorld(admin);
      const foreign: TenantContext = { tenantId: other.tenantId, workspaceId: other.workspaceId, userId: f.approverUserId };
      await expect(issuer.issue(foreign, request(f))).rejects.toMatchObject({ codes: ['ACTION_NOT_FOUND'] });
      await expect(issuer.issue(f.ctx, { actionId: randomUUID() })).rejects.toMatchObject({ codes: ['ACTION_NOT_FOUND'] });
    });

    it('preserves every refusal reason in the audit trail (in its own transaction)', async () => {
      const f = await fresh({ omitOwner: true, omitBoundaries: true });
      const e = await refusal(f);
      expect(e.refusalAudited).toBe(true);
      const row = (await admin.query(`SELECT detail FROM ${S}.approval_audit_events WHERE business_id=$1 AND event_type='package.issuance_refused'`, [f.businessId])).rows[0];
      expect(row.detail.schema).toBe('package-issuance-audit/1');
      expect(row.detail.refusals.map((r: any) => r.code).sort()).toEqual(['BOUNDARIES_MISSING', 'OWNER_MISSING']);
      expect(row.detail.actionId).toBe(f.actionId);
    });
  });

  describe('idempotency and versioning', () => {
    it('replays the identical authoritative inputs to the existing package (no new version, no new audit)', async () => {
      const f = await fresh();
      const first = await issuer.issue(f.ctx, request(f));
      const again = await issuer.issue(f.ctx, { ...request(f), correlationId: randomUUID() });
      expect(again.outcome).toBe('REPLAYED');
      expect(again.package.integrity.digest).toBe(first.package.integrity.digest);
      expect(again.issuanceAuditEventId).toBeNull();
      expect(await versions(f)).toBe(1);
      expect(await audits(f, 'package.issued')).toBe(1);
    });

    it('is safe under concurrent issuance of the same action (one version, one audit)', async () => {
      const f = await fresh();
      const results = await Promise.allSettled(Array.from({ length: 6 }, () => issuer.issue(f.ctx, request(f))));
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
      const digests = new Set(results.map((r) => (r as PromiseFulfilledResult<any>).value.package.integrity.digest));
      expect(digests.size).toBe(1);
      expect(await versions(f)).toBe(1);
      expect(await audits(f, 'package.issued')).toBe(1);
    });

    it('changed authoritative inputs issue the next version, which supersedes (never overwrites) the previous one', async () => {
      const f = await fresh();
      const v1 = await issuer.issue(f.ctx, request(f));
      await new AuthorizedActionBoundaryRepository().recordBoundaries(f.ctx, {
        businessId: f.businessId, actionId: f.actionId, captureId: f.captureId as string,
        executionWindow: G({ startsAt: iso(new Date(Date.now() + HOUR)), endsAt: iso(new Date(Date.now() + 8 * HOUR)) }),
        preconditions: G([{ code: 'stock_available', operator: 'gte', operand: 1 }]),
        budget: G({ amount: '999.00', currency: 'USD' }), rollback: G({ instructions: 'Restore the previous reorder policy.' }),
        monitoring: G({ metrics: [{ metricCode: 'stockouts', target: 0, unit: 'count' }] }), simulationRun: G(randomUUID()),
        authoredByUserId: f.approverUserId, correlationId: randomUUID(),
      } as any);
      const v2 = await issuer.issue(f.ctx, request(f));
      expect(v2.outcome).toBe('ISSUED');
      expect(v2.package.identity.packageVersion).toBe(2);
      expect(v2.package.identity.packageId).toBe(v1.package.identity.packageId);
      expect(v2.package.identity.supersedes).toEqual({ packageId: v1.package.identity.packageId, packageVersion: 1 });
      const stored1 = await packages.getVersion(f.ctx, v1.package.identity.packageId, 1);
      expect(stored1?.digest).toBe(v1.package.integrity.digest);
      const lifecycle = await packages.listLifecycle(f.ctx, v1.package.identity.packageId, 1);
      expect(lifecycle.map((e) => e.state)).toEqual(['ISSUED', 'SUPERSEDED']);
      expect((await issuer.issue(f.ctx, request(f))).outcome).toBe('REPLAYED');
    });

    it('does not re-issue a package that was revoked, and does not supersede it', async () => {
      const f = await fresh();
      const first = await issuer.issue(f.ctx, request(f));
      await packages.revoke(f.ctx, first.package.identity.packageId, 1, { actorUserId: f.approverUserId, reason: 'mistake', correlationId: randomUUID() });
      expect((await refusal(f)).codes).toContain('EXISTING_PACKAGE_NOT_REPLAYABLE');
      await new AuthorizedActionBoundaryRepository().recordBoundaries(f.ctx, {
        businessId: f.businessId, actionId: f.actionId, captureId: f.captureId as string,
        executionWindow: G({ startsAt: iso(new Date(Date.now() + HOUR)), endsAt: iso(new Date(Date.now() + 8 * HOUR)) }),
        preconditions: G([{ code: 'stock_available', operator: 'gte', operand: 1 }]), budget: G({ amount: '5.00', currency: 'USD' }),
        rollback: G({ instructions: 'Restore the previous reorder policy.' }), monitoring: G({ metrics: [{ metricCode: 'stockouts', target: 0, unit: 'count' }] }),
        simulationRun: G(randomUUID()), authoredByUserId: f.approverUserId, correlationId: randomUUID(),
      } as any);
      expect((await refusal(f)).codes).toContain('SUPERSESSION_BLOCKED');
      expect(await versions(f)).toBe(1);
    });

    it('rejects a tampered persisted package instead of replaying or superseding it', async () => {
      const f = await fresh();
      const first = await issuer.issue(f.ctx, request(f));
      const c = await admin.connect();
      try {
        await c.query('BEGIN');
        await c.query("SET LOCAL session_replication_role = 'replica'");
        await c.query(`UPDATE ${S}.authorized_action_package_versions SET package = jsonb_set(package, '{action,parameters,reorderPoint}', '9999') WHERE package_id = $1`, [first.package.identity.packageId]);
        await c.query('COMMIT');
      } finally {
        c.release();
      }
      expect((await refusal(f)).codes).toContain('STORED_PACKAGE_INVALID');
    });
  });

  describe('transaction and audit', () => {
    it('writes the issuance audit and the package in one transaction (both visible, linked by digest)', async () => {
      const f = await fresh();
      const r = await issuer.issue(f.ctx, request(f));
      const row = (await admin.query(`SELECT id, detail FROM ${S}.approval_audit_events WHERE business_id=$1 AND event_type='package.issued'`, [f.businessId])).rows[0];
      expect(row.id).toBe(r.issuanceAuditEventId);
      expect(row.detail).toMatchObject({
        schema: 'package-issuance-audit/1', actionId: f.actionId, decisionId: f.decisionId, approvalAuditEventId: f.approvalAuditEventId,
        packageId: r.package.identity.packageId, packageVersion: 1, digest: r.package.integrity.digest,
      });
    });

    it('an audit failure rolls the whole issuance back (no header, no package) and is itself reported', async () => {
      const f = await fresh();
      class FailingAudit extends AuthorizedActionIssuanceRepository {
        override async recordAudit(ctx: TenantContext, input: Parameters<AuthorizedActionIssuanceRepository['recordAudit']>[1]): Promise<string> {
          if (input.eventType === 'package.issued') throw new Error('audit store unavailable');
          return super.recordAudit(ctx, input);
        }
      }
      const e = await refusal(f, new AuthorizedActionPackageIssuer({ issuance: new FailingAudit() }));
      expect(e.codes).toEqual(['AUDIT_FAILED']);
      expect(await versions(f)).toBe(0);
      expect(await headers(f)).toBe(0);
      expect(await audits(f, 'package.issued')).toBe(0);
      expect(await audits(f, 'package.issuance_refused')).toBe(1);
    });

    it('a package persistence failure rolls the already-written audit back too', async () => {
      const f = await fresh();
      class FailingStore extends AuthorizedActionPackageRepository {
        override async insertVersion(): Promise<never> { throw new Error('package store unavailable'); }
      }
      const e = await refusal(f, new AuthorizedActionPackageIssuer({ packages: new FailingStore() }));
      expect(e.codes).toEqual(['PERSISTENCE_FAILED']);
      expect(await audits(f, 'package.issued')).toBe(0);
      expect(await versions(f)).toBe(0);
      expect(await headers(f)).toBe(0);
      expect(await audits(f, 'package.issuance_refused')).toBe(1);
    });

    it('does not touch approval decisions, the approval audit of the decision, or any BO table', async () => {
      const f = await fresh();
      const before = await count(`SELECT count(*) n FROM ${S}.approval_audit_events WHERE decision_id=$1 AND event_type LIKE 'approval.%'`, [f.decisionId]);
      await issuer.issue(f.ctx, request(f));
      expect(await count(`SELECT count(*) n FROM ${S}.approval_audit_events WHERE decision_id=$1 AND event_type LIKE 'approval.%'`, [f.decisionId])).toBe(before);
      expect((await admin.query(`SELECT status FROM ${S}.approval_decisions WHERE id=$1`, [f.decisionId])).rows[0].status).toBe('approved');
    });
  });
});
