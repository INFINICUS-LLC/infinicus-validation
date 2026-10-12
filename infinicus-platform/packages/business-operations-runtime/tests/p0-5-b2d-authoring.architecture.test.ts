/**
 * Block B2d - architecture guard (no database required) for the end-to-end modified-approval authoring chain.
 * The chain ends at the sealed package: ADI executes nothing, ABA owns authorization, BO owns operational truth, the verifier boundary holds,
 * the issuer is the only sealer and builds from persisted authority, and nothing here executes, mutates inventory or enables a capability.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const PLATFORM = resolve(__dirname, '../../..');
const SKIP = new Set(['node_modules', 'dist', '.turbo', '.next', 'coverage']);
function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) yield full;
  }
}
const isTest = (rel: string): boolean => /(^|\/)(tests?|__tests__)\//.test(rel) || /\.test\.[tj]sx?$/.test(rel);
const strip = (src: string): string => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const production: { rel: string; code: string }[] = [];
const tests: { rel: string; code: string }[] = [];
for (const root of ['apps', 'packages', 'layers']) {
  for (const file of walk(join(PLATFORM, root))) {
    const rel = relative(PLATFORM, file).split('\\').join('/');
    (isTest(rel) ? tests : production).push({ rel, code: strip(readFileSync(file, 'utf8')) });
  }
}
const read = (rel: string): string => production.find((f) => f.rel === rel)?.code ?? '';
const under = (prefixes: string[]) => production.filter((f) => prefixes.some((p) => f.rel.startsWith(p)));
const migration = (name: string): string => readFileSync(join(PLATFORM, 'infrastructure/database/migrations', name), 'utf8');

const ISSUER = 'packages/workflow/src/AuthorizedActionPackageIssuer.ts';
const POLICY = 'packages/workflow/src/packageIssuancePolicy.ts';
const AUTHORING = 'packages/workflow/src/AbaAuthoringService.ts';
const E2E = 'apps/api/tests/p0-5-b2d-modified-approval-authoring.e2e.test.ts';
const ABA = ['packages/workflow/src/', 'packages/database/src/repositories/approved_action/', 'layers/approved-business-action/'];
const ADI = ['layers/ai-decision-intelligence/'];

describe('B2d architecture: the authoring chain ends at the sealed package', () => {
  it('scans the real tree (not vacuous) and the primary E2E proof exists', () => {
    expect(production.length).toBeGreaterThan(200);
    expect(tests.find((f) => f.rel === E2E)?.code.length ?? 0).toBeGreaterThan(10000);
    expect(read(ISSUER).length).toBeGreaterThan(3000);
  });

  it('ADI still executes nothing: no executor, package, evidence or Business Operations dependency', () => {
    const adi = under(ADI);
    expect(adi.length).toBeGreaterThan(0);
    for (const f of adi) expect(f.code, f.rel).not.toMatch(/OperationalCommandExecutor|AuthorizedActionPackage|sealAuthorizedActionPackage|ExecutionEvidence|business_operations\.|@infinicus\/business-operations-runtime|ACTION_AUTHORIZED/);
  });

  it('ABA authorizes and BO owns operational truth: neither reads the other\'s private tables', () => {
    for (const f of under(ABA)) expect(f.code, f.rel).not.toMatch(/business_operations\.|@infinicus\/business-operations-runtime|InventoryPolicyEvaluation(?:Repository|Service)|InventoryPolicyFactsRepository|BoGovernanceEvidenceVerifier/);
    for (const f of under(['packages/business-operations-runtime/src/', 'packages/database/src/repositories/bo/'])) {
      expect(f.code, f.rel).not.toMatch(/approved_business_action\.|@infinicus\/workflow|AuthorizedActionPackageRepository|AuthorizedActionCaptureRepository|ActionExecutionPlan/);
    }
  });

  it('the verifier boundary holds: ABA depends on the port; the BO adapter is constructed at the composition root only', () => {
    expect(read(AUTHORING)).toMatch(/GovernanceEvidenceVerifier/);
    expect(production.filter((f) => /new BoGovernanceEvidenceVerifier\(/.test(f.code)).map((f) => f.rel)).toEqual(['apps/api/src/app.ts']);
  });

  it('the issuer is the ONLY sealer, takes identifiers only, and builds the package from persisted authority', () => {
    expect(production.filter((f) => /\bsealAuthorizedActionPackage\(/.test(f.code)).map((f) => f.rel).sort()).toEqual([
      'packages/handoff-contracts/src/authorized-action-package/validator.ts', ISSUER,
    ].sort());
    const iface = /export interface IssuePackageRequest \{([\s\S]*?)\n\}/.exec(readFileSync(join(PLATFORM, ISSUER), 'utf8'));
    expect(iface).not.toBeNull();
    expect([...iface![1].matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]).sort()).toEqual(['actionId', 'correlationId', 'permissionUsed']);
    // everything else is loaded from persisted facts
    expect(read(ISSUER)).toMatch(/captures\.getCaptureByActionId|this\.deps\.captures\./);
    expect(read(ISSUER)).toMatch(/boundaries\./);
    expect(read(ISSUER)).toMatch(/issuance\./);
  });

  it('the executable parameters come from authorized_action_captures.final_parameters and are never reconstructed later', () => {
    expect(read(POLICY)).toMatch(/parameters: capture\.finalParameters,/);
    expect(read(POLICY)).not.toMatch(/deriveFinalParameters|proposedParameters.*changes|applyChanges/);
    // reconstruction from original + delta exists in exactly one production place: ABA capture time (the database re-derives and must agree)
    expect(production.filter((f) => /deriveFinalParameters\(/.test(f.code)).map((f) => f.rel)).toEqual([AUTHORING]);
    expect(read(ISSUER)).not.toMatch(/deriveFinalParameters|approval_decision|ApprovalDecisionRepository.*parameters/);
  });

  it('the owner comes from canonical Identity/Tenancy: the database verifies an ACTIVE membership; no browser id is trusted', () => {
    expect(migration('0177_create_authorized_action_capture.sql')).toMatch(/tenancy\.memberships/);
    expect(read(AUTHORING)).toMatch(/assignedByUserId: ctx\.userId/);
    expect(read(POLICY)).not.toMatch(/req(?:uest)?\.body|input\.owner/);
  });

  it('issuance re-checks CURRENT approver authority (decision-time authority is not enough) and the Simulation exemption is action-specific', () => {
    expect(read(POLICY)).toMatch(/AUTHORITY_REVOKED/);
    expect(read(POLICY)).toMatch(/AUTHORITY_NOT_ESTABLISHED/);
    expect(read(POLICY)).toContain('simulationNotApplicableProblem(');
    expect(read('packages/handoff-contracts/src/authorized-action-package/canonical-actions.ts')).toMatch(/new Set<string>\(\[\s*`\$\{INVENTORY_REORDER_POLICY_UPDATE_V1\.code\}@\$\{INVENTORY_REORDER_POLICY_UPDATE_V1\.schemaVersion\}`,\s*\]\)/);
  });

  it('nothing executes: the production capability registry is empty, no execution adapter, no ACTION_AUTHORIZED outside the P0-6b files, no ExecutionEvidence, no P0-6', () => {
    expect(read('packages/business-operations-runtime/src/authorized-action/boActionCapabilities.ts')).toMatch(/PRODUCTION_SUPPORTED_ACTION_TYPES: readonly string\[\] = Object\.freeze\(\[\]\)/);
    // P0-6b is authorized: exactly the event contract, the ABA announcer, the BO consumer and the worker composition may name ACTION_AUTHORIZED.
    expect(production.filter((f) => /ACTION_AUTHORIZED/.test(f.code)).map((f) => f.rel).sort()).toEqual(['packages/business-operations-runtime/src/authorized-action/AuthorizedActionNotificationConsumer.ts', 'packages/event-contracts/src/action-authorized.ts', 'packages/event-contracts/src/index.ts', 'packages/event-worker/src/compose.ts', 'packages/workflow/src/ActionAuthorizedAnnouncer.ts']);
    expect(production.filter((f) => /\bExecutionEvidence\b/.test(f.code) && !f.rel.startsWith('packages/handoff-contracts/')).map((f) => f.rel)).toEqual([]);
    // Data-capture Block E (O-10) is authorized: exactly the BO executor and the BO command types may carry the configure command / state; nothing else.
    expect(production.filter((f) => /configure_inventory_reorder_policy|reorder_policy_state|executeAuthorizedAction|InventoryPolicyExecutionAdapter/.test(f.code)).map((f) => f.rel).sort()).toEqual(['packages/business-operations-runtime/src/OperationalCommandExecutor.ts', 'packages/business-operations-runtime/src/authorized-action-execution/InventoryReorderPolicyExecutionAdapter.ts', 'packages/business-operations-runtime/src/types.ts']);
    // the authoring surface and the issuer never reach Business Operations execution or intake
    for (const rel of [ISSUER, AUTHORING, POLICY, 'apps/api/src/routes/abaAuthoring.ts']) {
      expect(read(rel), rel).not.toMatch(/OperationalCommandExecutor|AuthorizedActionIntakeService|authorized_action_receipts|PRODUCTION_BO_CAPABILITIES|markConsumed|CONSUMED/);
    }
  });

  it('the primary B2d E2E proof does not extend into BO intake, claim, consumption or execution', () => {
    const e2e = tests.find((f) => f.rel === E2E)!.code;
    expect(e2e).not.toMatch(/AuthorizedActionIntakeService|OperationalCommandExecutor|\/authorized-action-intake|claim\(|markConsumed|executeOn\(/);
    expect(e2e).not.toMatch(/fakeVerifier|evidenceVerifier\s*:/); // the production composition root, no injected verifier
    expect(e2e).toMatch(/await buildApp\(loadConfig\(\{ DATABASE_URL: process\.env\.DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '5000' \}\)\)/);
  });
});
