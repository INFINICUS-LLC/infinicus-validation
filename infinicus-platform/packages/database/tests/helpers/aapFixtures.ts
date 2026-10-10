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

/** Builds upstream ABA rows directly. FK/trigger checks of the UPSTREAM tables are bypassed for fixture speed only. */
export async function makeFixture(admin: Pool, decisionStatus = 'approved'): Promise<Fixture> {
  const f: Fixture = {
    tenantId: randomUUID(), workspaceId: randomUUID(), businessId: randomUUID(),
    decisionId: randomUUID(), actionId: randomUUID(), actionVersionId: randomUUID(),
  };
  const c = await admin.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL session_replication_role = 'replica'");
    const slug = `t${f.tenantId.slice(0, 8)}`;
    await c.query('INSERT INTO tenancy.tenants (id, name, slug) VALUES ($1,$2,$3)', [f.tenantId, slug, slug]);
    await c.query('INSERT INTO tenancy.workspaces (id, tenant_id, name, slug) VALUES ($1,$2,$3,$4)', [f.workspaceId, f.tenantId, slug, slug]);
    await c.query(
      'INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code) VALUES ($1,$2,$3,$4,$5)',
      [f.businessId, f.tenantId, f.workspaceId, slug, slug],
    );
    await c.query(
      `INSERT INTO ${S}.approval_decisions (id, tenant_id, workspace_id, business_id, review_package_id, approver_assignment_id, decision_code, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [f.decisionId, f.tenantId, f.workspaceId, f.businessId, randomUUID(), randomUUID(), `d-${slug}`, decisionStatus],
    );
    await c.query(
      `INSERT INTO ${S}.approved_actions (id, tenant_id, workspace_id, business_id, decision_id, action_code) VALUES ($1,$2,$3,$4,$5,$6)`,
      [f.actionId, f.tenantId, f.workspaceId, f.businessId, f.decisionId, `a-${slug}`],
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

