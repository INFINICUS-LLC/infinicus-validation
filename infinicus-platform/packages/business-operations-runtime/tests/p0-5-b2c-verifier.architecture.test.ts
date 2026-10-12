/**
 * Block B2c - architecture guard (no database required): the real BO evidence verifier, the BO evaluation route, the modifiedAt source
 * and the narrow Simulation exemption. ABA depends on the verifier PORT only; the adapter is connected at the API composition root;
 * nothing here authorizes, issues, executes, mutates inventory or emits ExecutionEvidence.
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
for (const root of ['apps', 'packages', 'layers']) {
  for (const file of walk(join(PLATFORM, root))) {
    const rel = relative(PLATFORM, file).split('\\').join('/');
    if (!isTest(rel)) production.push({ rel, code: strip(readFileSync(file, 'utf8')) });
  }
}
const read = (rel: string): string => production.find((f) => f.rel === rel)?.code ?? '';
const under = (prefixes: string[]) => production.filter((f) => prefixes.some((p) => f.rel.startsWith(p)));

const BO_DIR = 'packages/business-operations-runtime/src/inventory-policy/';
const VERIFIER = `${BO_DIR}BoGovernanceEvidenceVerifier.ts`;
const RULESET = `${BO_DIR}ruleSet.ts`;
const ROUTE = 'apps/api/src/routes/inventoryPolicyEvaluations.ts';
const APP = 'apps/api/src/app.ts';
const AUTHORING = 'packages/workflow/src/AbaAuthoringService.ts';
const DECISIONS = 'packages/database/src/repositories/approved_action/ApprovalDecisionRepository.ts';
const CANON = 'packages/handoff-contracts/src/authorized-action-package/canonical-actions.ts';
const ABA = ['packages/workflow/src/', 'packages/database/src/repositories/approved_action/', 'packages/handoff-contracts/src/'];

describe('B2c architecture', () => {
  it('scans the real tree (not vacuous)', () => {
    expect(production.length).toBeGreaterThan(200);
    expect(read(VERIFIER).length).toBeGreaterThan(1000);
    expect(read(ROUTE).length).toBeGreaterThan(500);
    expect(read(AUTHORING).length).toBeGreaterThan(5000);
  });

  it('ABA depends on the GovernanceEvidenceVerifier PORT only: no BO package, repository, table or adapter appears in ABA code', () => {
    for (const f of under(ABA)) {
      expect(f.code, f.rel).not.toMatch(/@infinicus\/business-operations-runtime|BoGovernanceEvidenceVerifier|InventoryPolicyEvaluation(?:Service|Repository)|InventoryPolicyFactsRepository|inventory_policy_evaluations|business_operations\./);
    }
    expect(read(AUTHORING)).toMatch(/import type \{[^}]*GovernanceEvidenceVerifier[^}]*\} from '@infinicus\/handoff-contracts'/);
    expect(read(AUTHORING)).toMatch(/evidenceVerifier:\s*null/); // the service itself registers nothing: fail closed by default
    expect(read(AUTHORING)).toContain('this.d.evidenceVerifier');
  });

  it('the concrete adapter is constructed at the API composition root only', () => {
    expect(production.filter((f) => /new BoGovernanceEvidenceVerifier\(/.test(f.code)).map((f) => f.rel)).toEqual([APP]);
    expect(read(APP)).toMatch(/evidenceVerifier: new BoGovernanceEvidenceVerifier\(\), \.\.\.options\.abaAuthoring/);
  });

  it('BO does not import ABA/workflow internals; the verifier uses BO repositories and shared contracts only', () => {
    const specs = [...read(VERIFIER).matchAll(/from '([^']+)'/g)].map((m) => m[1]).filter((s) => !s.startsWith('.'));
    expect([...new Set(specs)].sort()).toEqual(['@infinicus/database', '@infinicus/handoff-contracts']);
    expect(read(VERIFIER)).not.toMatch(/@infinicus\/workflow|approved_business_action|AuthorizedActionPackageRepository|withSharedTenantTransaction/);
  });

  it('the evaluation route is BO-owned: bo:write only (no new permission), idempotent, no ABA/workflow import', () => {
    const route = read(ROUTE);
    expect(route).toContain("REQUEST_EVALUATION_PERMISSION = 'bo:write'");
    expect(route).toMatch(/server\.post\('\/v1\/businesses\/:businessId\/inventory-policy-evaluations'/);
    expect(route).toMatch(/requirePermission\(REQUEST_EVALUATION_PERMISSION\)[\s\S]*requireIdempotencyKey/);
    expect(route.match(/requirePermission\(/g)).toHaveLength(1);
    expect(route).not.toMatch(/aba:|platform:admin|@infinicus\/workflow|@infinicus\/onboarding|approved_business_action/);
    const specs = [...route.matchAll(/from '([^']+)'/g)].map((m) => m[1]).filter((s) => !s.startsWith('.') && !s.startsWith('fastify'));
    expect([...new Set(specs)].sort()).toEqual(['@infinicus/business-operations-runtime', '@infinicus/database']);
  });

  it('the route only requests evidence: it authorizes nothing, issues nothing, executes nothing, mutates no inventory and emits nothing', () => {
    for (const rel of [ROUTE, VERIFIER, 'apps/api/src/schemas/inventoryPolicyEvaluations.ts']) {
      expect(read(rel), rel).not.toMatch(/ACTION_AUTHORIZED|ExecutionEvidence|OperationalCommandExecutor|sealAuthorizedActionPackage|AuthorizedActionPackageIssuer|emit_outbox_event|business_event|CanonicalEventPublisher|\bINSERT\b|\bUPDATE\b|\bDELETE\b|inventory_balances|inventory_movements/);
    }
  });

  it('the ONLY package sealer remains the issuer; no execution evidence exists anywhere in production code', () => {
    expect(production.filter((f) => /\bsealAuthorizedActionPackage\(/.test(f.code)).map((f) => f.rel).sort()).toEqual([
      'packages/handoff-contracts/src/authorized-action-package/validator.ts', 'packages/workflow/src/AuthorizedActionPackageIssuer.ts',
    ].sort());
    expect(production.filter((f) => /\bExecutionEvidence\b/.test(f.code) && !f.rel.startsWith('packages/handoff-contracts/')).map((f) => f.rel)).toEqual([]);
  });

  it('the production capability registry is still empty, no ABA->BO execution transport exists and P0-6 stays disabled', () => {
    expect(read('packages/business-operations-runtime/src/authorized-action/boActionCapabilities.ts')).toMatch(/PRODUCTION_SUPPORTED_ACTION_TYPES: readonly string\[\] = Object\.freeze\(\[\]\)/);
    // Data-capture Block E (O-10) is authorized: exactly the BO executor and the BO command types may carry the configure command / state; nothing else.
    expect(production.filter((f) => /configure_inventory_reorder_policy|reorder_policy_state/.test(f.code)).map((f) => f.rel).sort()).toEqual(['packages/business-operations-runtime/src/OperationalCommandExecutor.ts', 'packages/business-operations-runtime/src/authorized-action-execution/InventoryReorderPolicyExecutionAdapter.ts', 'packages/business-operations-runtime/src/types.ts']);
    for (const rel of [ROUTE, VERIFIER, `${BO_DIR}InventoryPolicyEvaluationService.ts`]) expect(read(rel)).not.toMatch(/AuthorizedActionIntakeService|PRODUCTION_BO_CAPABILITIES|explicitCapabilities/);
  });

  describe('modifiedAt authority (B2c ruling): approval_decisions.updated_at of the decided approved_with_modifications row', () => {
    it('ABA takes modifiedAt from the decision repository, never from the capture clock, the request, the audit log or approval_decision_modifications', () => {
      const code = read(AUTHORING);
      expect(code).toMatch(/const modifiedAt = await this\.d\.decisions\.getModifiedDecisionFinalAt\(ctx, decision\.id\);/);
      expect(code).toMatch(/modifiedByUserId: ctx\.userId, modifiedAt, changes/);
      expect(code).not.toMatch(/modifiedAt:\s*now|modifiedAt = now|modifiedAt:\s*input|approval_decision_modifications|approval_audit_events|addModification|approvalAudit/);
    });

    it('the decision repository reads ONLY approval_decisions.updated_at for the decided state; live approval never needs approval_decision_modifications', () => {
      const code = read(DECISIONS);
      const m = /async getModifiedDecisionFinalAt[\s\S]*?\n  \}\n/.exec(code);
      expect(m).not.toBeNull();
      expect(m![0]).toContain('updated_at');
      expect(m![0]).toContain("status = 'approved_with_modifications'");
      expect(m![0]).not.toMatch(/approval_decision_modifications|approval_audit_events|created_at/);
      // the only production caller of addModification (the unused structure) does not exist: the live flow never writes it
      expect(production.filter((f) => /\.addModification\(/.test(f.code)).map((f) => f.rel)).toEqual([]);
      expect(production.filter((f) => /approval_decision_modifications/.test(f.code)).map((f) => f.rel)).toEqual([DECISIONS]);
    });
  });

  describe('freshness (24 hours) has one definition', () => {
    it('the constant lives with the rule-set registry and nowhere else; verifier, service and route never restate it', () => {
      expect(read(RULESET)).toMatch(/INVENTORY_REORDER_POLICY_V1_MAX_EVIDENCE_AGE_MS = 24 \* 60 \* 60 \* 1000/);
      expect(read(RULESET)).toMatch(/maxEvidenceAgeMs: INVENTORY_REORDER_POLICY_V1_MAX_EVIDENCE_AGE_MS/);
      expect(production.filter((f) => /24 \* 60 \* 60 \* 1000|86_?400_?000|24 \* 3_?600_?000/.test(f.code)).map((f) => f.rel)).not.toContain(VERIFIER);
      expect(read(VERIFIER)).toMatch(/ruleSet\.maxEvidenceAgeMs/);
      expect(read(VERIFIER)).not.toMatch(/\b(?:24|86_?400_?000)\b/);
      expect(read(ROUTE)).not.toMatch(/maxEvidenceAge|86_?400/i);
      expect(read('apps/api/src/schemas/inventoryPolicyEvaluations.ts')).not.toMatch(/maxEvidenceAge|freshness|maxAge/i);
    });
  });

  describe('Simulation NOT_APPLICABLE exemption is exactly one action type, one reason, one rule', () => {
    it('the allow-list names only inventory_reorder_policy_update@1 and is frozen; both gates use the one helper', () => {
      const canon = read(CANON);
      expect(canon).toMatch(/SIMULATION_NOT_APPLICABLE_REASON_CODE = 'NO_APPLICABLE_SIMULATION_MODEL'/);
      expect(canon).toMatch(/Object\.freeze\(new Set<string>\(\[\s*`\$\{INVENTORY_REORDER_POLICY_UPDATE_V1\.code\}@\$\{INVENTORY_REORDER_POLICY_UPDATE_V1\.schemaVersion\}`,\s*\]\)\)/);
      expect(production.filter((f) => /SIMULATION_NOT_APPLICABLE_ALLOWED\.add|simulationNotApplicableAllowed:\s*new Set\(\[['"`]/.test(f.code)).map((f) => f.rel)).toEqual([]);
      expect(read(AUTHORING)).toContain('simulationNotApplicableProblem(');
      expect(read('packages/workflow/src/packageIssuancePolicy.ts')).toContain('simulationNotApplicableProblem(');
      // a different canonical type never inherits it: the registry contains exactly one canonical type
      expect(canon).toMatch(/CANONICAL_ACTION_TYPES: readonly ActionTypeContract\[\] = Object\.freeze\(\[INVENTORY_REORDER_POLICY_UPDATE_V1\]\)/);
    });
  });

  describe('fact/currency consistency is NOT claimed atomic', () => {
    it('BO reads facts through its repository and the declared currency through the Business Administration reader, in separate reads; no shared-transaction widening', () => {
      const svc = read(`${BO_DIR}InventoryPolicyEvaluationService.ts`);
      expect(svc).toMatch(/this\.deps\.facts\.loadSnapshot\(/);
      expect(svc).toMatch(/this\.deps\.declaredCurrency\.getCurrent\(/);
      for (const f of under([BO_DIR])) expect(f.code, f.rel).not.toMatch(/withSharedTenantTransaction|business_currency_declarations/);
      expect(read(ROUTE)).not.toMatch(/withSharedTenantTransaction/);
      expect(read(`${BO_DIR}InventoryPolicyEvaluationService.ts`)).not.toMatch(/atomic snapshot|single snapshot|same snapshot/i);
    });
  });
});
