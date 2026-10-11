/**
 * P0-5 ABA authoring / administration - architecture guard (no database required).
 * The authoring surface governs and prepares; it never seals, never touches Business Operations, never emits and never executes.
 * Static scan of the real production tree.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLATFORM = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SERVICE = 'packages/workflow/src/AbaAuthoringService.ts';
const ROUTES = 'apps/api/src/routes/abaAuthoring.ts';
const SCHEMAS = 'apps/api/src/schemas/abaAuthoring.ts';
const AUDIT = 'packages/database/src/repositories/approved_action/GovernanceAuditRepository.ts';
const SURFACE = [SERVICE, ROUTES, SCHEMAS, AUDIT];

const code = (rel: string): string => readFileSync(join(PLATFORM, rel), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

describe('ABA authoring architecture', () => {
  it('scans real files (not vacuous)', () => {
    for (const rel of SURFACE) expect(code(rel).length, rel).toBeGreaterThan(500);
  });

  it('never seals: only the issuer calls the sealer, and the routes reach the issuer only through the authoring service', () => {
    for (const rel of SURFACE) expect(code(rel), rel).not.toMatch(/sealAuthorizedActionPackage|computeDigest/);
    expect(code(ROUTES)).not.toMatch(/AuthorizedActionPackageIssuer/);
    expect(code(SERVICE)).toMatch(/issuer\.issue\(/);
  });

  it('touches no Business Operations code or table, and writes no package row directly', () => {
    for (const rel of SURFACE) {
      const text = code(rel);
      expect(text, rel).not.toMatch(/business-operations|business_operations|@infinicus\/business-operations/);
      expect(text, rel).not.toMatch(/authorized_action_(receipts|claims|intake_attempts)|AuthorizedActionIntake|AuthorizedActionClaim/);
      expect(text, rel).not.toMatch(/INSERT INTO\s+\S*authorized_action_(packages|package_versions|lifecycle_events)/i);
    }
    // the package repository is used for READS only (status view); only the issuer persists packages
    const used = [...code(SERVICE).matchAll(/this\.d\.packages\.([a-zA-Z]+)/g)].map((m) => m[1]).sort();
    expect([...new Set(used)]).toEqual(['getAuthoritativeStatus', 'getHeaderByActionId', 'getLatestVersion']);
  });

  it('emits no event and records no execution: no outbox, ledger, ACTION_AUTHORIZED, ExecutionEvidence or inventory mutation', () => {
    for (const rel of SURFACE) {
      expect(code(rel), rel).not.toMatch(/ACTION_AUTHORIZED|outbox|event_ledger|EventPublisher|publishEvent|ExecutionEvidence|execution_evidence|inventory_balances|inventory_movements|\.execute\(/i);
    }
  });

  it('opens no nested shared transaction around the issuer: issuer.issue is never called inside withSharedTenantTransaction', () => {
    const text = code(SERVICE);
    const issueAt = text.indexOf('issuer.issue(');
    expect(issueAt).toBeGreaterThan(0);
    // the issuePackage method body: from its signature to the next method
    const start = text.lastIndexOf('async issuePackage');
    const body = text.slice(start, text.indexOf('\n  async ', start + 10) > 0 ? text.indexOf('\n  async ', start + 10) : undefined);
    expect(body).toContain('issuer.issue(');
    expect(body).not.toContain('withSharedTenantTransaction');
  });

  it('the issuer request carries identifiers only', () => {
    const text = code(SERVICE);
    const m = /issuer\.issue\(ctx,\s*\{([^}]*)\}/.exec(text);
    expect(m).not.toBeNull();
    const keys = m![1].split(',').map((k) => k.trim().split(':')[0].trim()).filter(Boolean).sort();
    expect(keys).toEqual(['actionId', 'correlationId', 'permissionUsed']);
  });

  it('derives rather than accepts authority: capture final parameters and governance basis come from the contract, not the request', () => {
    const text = code(SERVICE);
    expect(text).toContain('deriveFinalParameters');
    expect(text).toContain('requiredGovernanceDimensions');
    const captureBody = /export const captureBodySchema[\s\S]*?\.strict\(\)/.exec(code(SCHEMAS))?.[0] ?? '';
    expect(captureBody.length).toBeGreaterThan(50);
    expect(captureBody).not.toMatch(/finalParameters|digest|lifecycle|tenantId|userId|basis|evaluatedAt|modifiedAt/);
  });

  it('persists no caller-asserted evidence: a modification evaluation exists only as a registered verifier\'s VERIFIED answer', () => {
    const text = code(SERVICE);
    expect(text).toContain('this.d.evidenceVerifier');
    expect(text).toMatch(/verifier\.verify\(/);
    expect(text).not.toMatch(/evaluatedAt:\s*now\b/);
    expect(text).toMatch(/evaluatedAt:\s*verdict\.evaluatedAt/);
    // the production default registers no verifier and the simulation reference is verified before boundaries are stored
    expect(text).toMatch(/evidenceVerifier:\s*null/);
    expect(text).toMatch(/this\.d\.simulationRuns\.verify\(/);
  });

  it('every mutating service entry point audits through the governance audit repository', () => {
    const text = code(SERVICE);
    for (const action of ['aba.action_type.defined', 'aba.action_type.activated', 'aba.action_type.retired', 'aba.policy.created', 'aba.policy.version_added',
      'aba.policy.enabled', 'aba.policy.disabled', 'aba.capture.recorded', 'aba.owner.assigned', 'aba.boundaries.authored']) {
      expect(text, action).toContain(action);
    }
  });

  it('every route in the authoring file names an explicit permission and uses no ad-hoc authority', () => {
    const text = code(ROUTES);
    const routes = text.match(/server\.(get|post|put|patch|delete)\(/g) ?? [];
    const guarded = text.match(/preHandler:\s*(ADMIN|WRITE|READ)\(app\)/g) ?? [];
    expect(routes.length).toBeGreaterThanOrEqual(16);
    expect(guarded.length).toBe(routes.length);
    expect([...text.matchAll(/requirePermission\('([a-z]+:[a-z]+)'\)/g)].map((m) => m[1]).sort()).toEqual(['aba:admin', 'aba:read', 'aba:write']);
    expect(text).not.toMatch(/request\.body\.(tenantId|workspaceId|userId)|x-tenant|headers\[/i);
  });
});
