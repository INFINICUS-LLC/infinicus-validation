/**
 * Shared fixtures for the P0-5 Block 3 AuthorizedActionPackage tests (3a database proof, 3b repository proof).
 * Test-only. The document is structurally complete for the 0176 guards; its digest is a placeholder because the database
 * (and this repository) treat the digest as tamper evidence only - recomputation belongs to the contract validator.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- fixtures deliberately mutate arbitrary paths of a JSON document */
import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

export const S = 'approved_business_action';
export const HOUR = 3_600_000;
export const iso = (d: Date) => d.toISOString();

export interface Fixture {
  tenantId: string;
  workspaceId: string;
  businessId: string;
  decisionId: string;
  actionId: string;
  actionVersionId: string;
}

/** A tenant + workspace + business. Tests that create many fixtures share one world to keep the shared database small. */
export interface World {
  tenantId: string;
  workspaceId: string;
  businessId: string;
}

export async function makeWorld(admin: Pool): Promise<World> {
  const w: World = { tenantId: randomUUID(), workspaceId: randomUUID(), businessId: randomUUID() };
  const slug = `t${w.tenantId.slice(0, 8)}`;
  const c = await admin.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL session_replication_role = 'replica'");
    await c.query('INSERT INTO tenancy.tenants (id, name, slug) VALUES ($1,$2,$3)', [w.tenantId, slug, slug]);
    await c.query('INSERT INTO tenancy.workspaces (id, tenant_id, name, slug) VALUES ($1,$2,$3,$4)', [w.workspaceId, w.tenantId, slug, slug]);
    await c.query(
      'INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code) VALUES ($1,$2,$3,$4,$5)',
      [w.businessId, w.tenantId, w.workspaceId, slug, slug],
    );
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
  return w;
}

/**
 * Builds upstream ABA rows directly. FK/trigger checks of the UPSTREAM tables are bypassed for fixture speed only.
 * Pass a `world` to reuse a tenant/workspace/business (each call still gets its own decision, action and action version).
 */
export async function makeFixture(admin: Pool, decisionStatus = 'approved', world?: World): Promise<Fixture> {
  const w = world ?? await makeWorld(admin);
  const f: Fixture = { ...w, decisionId: randomUUID(), actionId: randomUUID(), actionVersionId: randomUUID() };
  const code = randomUUID().slice(0, 12);
  const c = await admin.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL session_replication_role = 'replica'");
    await c.query(
      `INSERT INTO ${S}.approval_decisions (id, tenant_id, workspace_id, business_id, review_package_id, approver_assignment_id, decision_code, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [f.decisionId, f.tenantId, f.workspaceId, f.businessId, randomUUID(), randomUUID(), `d-${code}`, decisionStatus],
    );
    await c.query(
      `INSERT INTO ${S}.approved_actions (id, tenant_id, workspace_id, business_id, decision_id, action_code) VALUES ($1,$2,$3,$4,$5,$6)`,
      [f.actionId, f.tenantId, f.workspaceId, f.businessId, f.decisionId, `a-${code}`],
    );
    await c.query(
      `INSERT INTO ${S}.approved_action_versions (id, tenant_id, workspace_id, business_id, action_id, version_number, description)
       VALUES ($1,$2,$3,$4,$5,1,'fixture')`,
      [f.actionVersionId, f.tenantId, f.workspaceId, f.businessId, f.actionId],
    );
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
  return f;
}

export interface VersionOpts {
  packageId: string;
  version?: number;
  level?: 2 | 3 | 4;
  decisionStatus?: string;
  issuedAt?: Date;
  expiresAt?: Date | null;
  decisionValidUntil?: Date | null;
  supersedes?: number | null;
  overrideDocument?: (doc: Record<string, any>) => void;
  overrideColumns?: Partial<Record<string, unknown>>;
}

/** A structurally complete aap/1 document. The digest is a placeholder: the DB treats it as tamper evidence only. */
export function version(f: Fixture, o: VersionOpts) {
  const v = o.version ?? 1;
  const level = o.level ?? 2;
  const mode = level === 2 ? 'HUMAN_APPROVAL' : 'RULE_AUTHORIZED';
  const issuedAt = o.issuedAt ?? new Date(Math.floor(Date.now() / 1000) * 1000);
  const expiresAt = o.expiresAt === undefined ? new Date(issuedAt.getTime() + HOUR) : o.expiresAt;
  const correlationId = randomUUID();
  const causationId = randomUUID();
  const digest = `sha256:${createHash('sha256').update(`${o.packageId}:${v}:${randomUUID()}`).digest('hex')}`;
  const supersedes = o.supersedes === undefined ? (v > 1 ? v - 1 : null) : o.supersedes;
  const doc: Record<string, any> = {
    contractVersion: 'aap/1',
    identity: { packageId: o.packageId, packageVersion: v, supersedes: supersedes === null ? null : { packageId: o.packageId, packageVersion: supersedes } },
    scope: { tenantId: f.tenantId, workspaceId: f.workspaceId, businessId: f.businessId },
    issuance: { issuedAt: iso(issuedAt), issuerComponent: 'aba.package-issuer' },
    action: { actionId: f.actionId, actionVersionId: f.actionVersionId, automationLevel: { level } },
    lineage: { decision: { decisionId: f.decisionId } },
    authorization: mode === 'HUMAN_APPROVAL' ? { mode, decisionStatus: o.decisionStatus ?? 'approved' } : { mode },
    validity: {
      decisionValidUntil: o.decisionValidUntil ? { state: 'VALUE', value: iso(o.decisionValidUntil) } : { state: 'NOT_APPLICABLE' },
      expiresAt: expiresAt ? { state: 'VALUE', value: iso(expiresAt) } : { state: 'NOT_APPLICABLE' },
    },
    consumption: { mode: 'SINGLE_USE' },
    trace: { correlationId, causationId },
    integrity: { canonicalVersion: 'aap-canonical/1', algorithm: 'sha256', digest },
  };
  o.overrideDocument?.(doc);
  const cols: Record<string, unknown> = {
    tenant_id: f.tenantId, workspace_id: f.workspaceId, business_id: f.businessId,
    package_id: o.packageId, package_version: v, supersedes_package_version: supersedes,
    action_version_id: f.actionVersionId, contract_version: 'aap/1', canonical_version: 'aap-canonical/1',
    digest_algorithm: 'sha256', digest, automation_level: level, authorization_mode: mode,
    issuer_component: 'aba.package-issuer', issued_at: issuedAt, expires_at: expiresAt,
    correlation_id: correlationId, causation_id: causationId, package: JSON.stringify(doc),
    ...o.overrideColumns,
  };
  return cols;
}


// ── Block 3c-1: capture and owner-assignment fixtures ─────────────────────────────────────────────────────────────

export interface CaptureFixture extends Fixture {
  decisionVersionId: string;
  /** A real user, used as the capturing approver and as the assigner. */
  userId: string;
  /** A real user with an ACTIVE membership in the fixture tenant and workspace. */
  ownerUserId: string;
  ownerMembershipId: string;
}

export async function makeUser(admin: Pool): Promise<string> {
  const id = randomUUID();
  await admin.query('INSERT INTO identity.users (id, email) VALUES ($1, $2)', [id, `u-${id}@example.test`]);
  return id;
}

export async function makeMembership(admin: Pool, tenantId: string, workspaceId: string, userId: string, status = 'active'): Promise<string> {
  const id = randomUUID();
  await admin.query('INSERT INTO tenancy.memberships (id, tenant_id, workspace_id, user_id, status) VALUES ($1,$2,$3,$4,$5)', [id, tenantId, workspaceId, userId, status]);
  return id;
}

export async function makeCaptureFixture(admin: Pool, decisionStatus = 'approved', world?: World): Promise<CaptureFixture> {
  const f = await makeFixture(admin, decisionStatus, world);
  const decisionVersionId = randomUUID();
  await admin.query(
    `INSERT INTO ${S}.approval_decision_versions (id, tenant_id, workspace_id, business_id, decision_id, version_number, summary)
     VALUES ($1,$2,$3,$4,$5,1,'fixture')`,
    [decisionVersionId, f.tenantId, f.workspaceId, f.businessId, f.decisionId],
  );
  const userId = await makeUser(admin);
  const ownerUserId = await makeUser(admin);
  const ownerMembershipId = await makeMembership(admin, f.tenantId, f.workspaceId, ownerUserId);
  return { ...f, decisionVersionId, userId, ownerUserId, ownerMembershipId };
}

/** A plain approval capture: the final set is exactly the proposed set. */
export function plainCaptureInput(f: CaptureFixture): any {
  const parameters = { price: 10, channel: 'email', tags: ['a', 'b'] };
  return {
    businessId: f.businessId, actionId: f.actionId, decisionId: f.decisionId, decisionVersionId: f.decisionVersionId,
    decisionStatus: 'approved',
    actionType: { code: 'adjust_price', schemaVersion: '1.0' },
    target: { kind: 'product', id: 'sku-123' },
    proposed: { state: 'VALUE', value: { source: { layer: 'ADI', recordType: 'decision_recommendation_version', recordId: randomUUID() }, parameters } },
    modification: { state: 'NOT_APPLICABLE', reason: { code: 'PLAIN_APPROVAL', statement: 'Approved as proposed.' } },
    modificationEvaluation: { state: 'NOT_APPLICABLE', reason: { code: 'NO_MODIFICATION', statement: 'No modification to evaluate.' } },
    finalParameters: parameters,
    capturedByUserId: f.userId,
    correlationId: randomUUID(),
  };
}

/** An approved-with-modifications capture: SET price, ADD limit, REMOVE channel. */
export function modifiedCaptureInput(f: CaptureFixture): any {
  const base = plainCaptureInput(f);
  const modifiedAt = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
  return {
    ...base,
    decisionStatus: 'approved_with_modifications',
    modification: {
      state: 'VALUE',
      value: {
        reason: 'Reduce exposure before launch.',
        modifiedByUserId: f.userId,
        modifiedAt: iso(modifiedAt),
        changes: [
          { parameter: 'price', operation: 'SET', before: 10, after: 12 },
          { parameter: 'limit', operation: 'ADD', after: 5 },
          { parameter: 'channel', operation: 'REMOVE', before: 'email' },
        ],
      },
    },
    modificationEvaluation: {
      state: 'VALUE',
      value: {
        basis: 'DECLARED_IMPACT',
        evidence: [{ dimension: 'COST', evaluatedAt: iso(new Date(modifiedAt.getTime() + 1000)), result: 'PASSED', evidenceRef: { kind: 'simulation_run', id: 'run-1' } }],
      },
    },
    finalParameters: { price: 12, tags: ['a', 'b'], limit: 5 },
  };
}

export function ownerInput(f: CaptureFixture, over: Record<string, unknown> = {}): any {
  return {
    businessId: f.businessId, actionId: f.actionId,
    owner: { userId: f.ownerUserId, membershipId: f.ownerMembershipId },
    roleCode: 'operations_lead', assignedByUserId: f.userId,
    dueAt: { state: 'VALUE', value: iso(new Date(Date.now() + 7 * 24 * HOUR)) },
    escalationPolicy: { state: 'VALUE', value: { ref: 'policy:default-escalation' } },
    correlationId: randomUUID(),
    ...over,
  };
}

// ── Block 3c-2: a bare tenant + workspace (no business) for registry and policy tests ──────────────────────────────

export interface Scope {
  tenantId: string;
  workspaceId: string;
}

export async function makeScope(admin: Pool): Promise<Scope> {
  const s: Scope = { tenantId: randomUUID(), workspaceId: randomUUID() };
  const slug = `g${s.tenantId.slice(0, 8)}`;
  await admin.query('INSERT INTO tenancy.tenants (id, name, slug) VALUES ($1,$2,$3)', [s.tenantId, slug, slug]);
  await admin.query('INSERT INTO tenancy.workspaces (id, tenant_id, name, slug) VALUES ($1,$2,$3,$4)', [s.workspaceId, s.tenantId, slug, slug]);
  return s;
}
