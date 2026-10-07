import type { Pool } from 'pg';
import { classifyOwnership, type OwnershipClassification, type OwnershipVerdict } from './classifyOwnership.js';
import { loadOwnershipEvidenceWith } from './OwnershipEvidenceRepository.js';

/**
 * Existing-business backfill — DRY RUN ONLY.
 *
 * Classifies every business and reports what an owner-authority backfill WOULD
 * do. It cannot write: the whole run is one `READ ONLY` transaction, so any
 * attempted write fails at the database. Executing grants is a separate,
 * explicitly authorised step that does not exist in this module.
 *
 * Run it with an operator connection that can enumerate tenants. For each
 * tenant/workspace it sets the same session settings a normal request carries,
 * so row-level security applies to every evidence query.
 */

export interface DryRunEntry {
  tenantId: string;
  workspaceId: string;
  businessId: string;
  businessCode: string;
  classification: OwnershipClassification;
  reason: string;
  /** PROVEN only: the user who would receive the assignment, and the proof that justifies it. */
  proposedGrantee: { userId: string; proofKind: string; membershipId: string; onboardingId: string | null } | null;
  /** Valid owners when AMBIGUOUS. */
  provenOwnerUserIds: string[];
  /** Tenant-wide owners without a business-specific link: CANDIDATE — NOT AUTO-GRANTED. */
  candidates: { userId: string; membershipId: string; label: string }[];
  existingAssignment: { assignmentId: string; userId: string; status: string } | null;
  holderStillProvenOwner: boolean | null;
  notes: string[];
}

export interface DryRunReport {
  generatedAt: string;
  mode: 'DRY_RUN_READ_ONLY';
  executed: false;
  tenantsScanned: number;
  businessesScanned: number;
  counts: Record<OwnershipClassification, number>;
  entries: DryRunEntry[];
  warnings: string[];
}

const ALL_CLASSES: OwnershipClassification[] = ['PROVEN', 'ALREADY_ASSIGNED', 'AMBIGUOUS', 'UNPROVEN', 'INVALID_INACTIVE'];

function toEntry(base: Pick<DryRunEntry, 'tenantId' | 'workspaceId' | 'businessId' | 'businessCode'>, v: OwnershipVerdict): DryRunEntry {
  const grantee = v.classification === 'PROVEN' ? v.provenOwners[0] : undefined;
  return {
    ...base,
    classification: v.classification,
    reason: v.reason,
    proposedGrantee: grantee
      ? { userId: grantee.userId, proofKind: grantee.proof.kind, membershipId: grantee.proof.membershipId, onboardingId: grantee.proof.onboardingId }
      : null,
    provenOwnerUserIds: v.classification === 'AMBIGUOUS' ? v.provenOwners.map((o) => o.userId) : [],
    candidates: v.candidates,
    existingAssignment: v.existingAssignment,
    holderStillProvenOwner: v.holderStillProvenOwner,
    notes: v.notes,
  };
}

export async function runOwnerAuthorityDryRun(pool: Pool): Promise<DryRunReport> {
  const counts = Object.fromEntries(ALL_CLASSES.map((c) => [c, 0])) as Record<OwnershipClassification, number>;
  const entries: DryRunEntry[] = [];
  const warnings: string[] = [];
  const tenants = new Set<string>();

  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');

    const workspaces = await client.query<{ tenant_id: string; workspace_id: string }>(
      'SELECT tenant_id, id AS workspace_id FROM tenancy.workspaces ORDER BY tenant_id, id'
    );
    if (workspaces.rows.length === 0) warnings.push('no workspaces visible: the connection may not be allowed to enumerate tenants');

    for (const ws of workspaces.rows) {
      tenants.add(ws.tenant_id);
      await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', ws.tenant_id]);
      await client.query('SELECT set_config($1, $2, true)', ['app.workspace_id', ws.workspace_id]);
      const businesses = await client.query<{ id: string; business_code: string }>(
        'SELECT id, business_code FROM platform.businesses WHERE workspace_id = $1 ORDER BY created_at, id', [ws.workspace_id]
      );
      for (const b of businesses.rows) {
        const evidence = await loadOwnershipEvidenceWith(client, { tenantId: ws.tenant_id, workspaceId: ws.workspace_id }, b.id);
        const verdict = classifyOwnership(evidence);
        counts[verdict.classification] += 1;
        entries.push(toEntry({ tenantId: ws.tenant_id, workspaceId: ws.workspace_id, businessId: b.id, businessCode: b.business_code }, verdict));
      }
    }
    await client.query('ROLLBACK');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  return {
    generatedAt: new Date().toISOString(),
    mode: 'DRY_RUN_READ_ONLY',
    executed: false,
    tenantsScanned: tenants.size,
    businessesScanned: entries.length,
    counts,
    entries,
    warnings,
  };
}
