/**
 * Read-only service around {@link deriveCompliantReorderPolicy} (AC-1). It loads exactly the facts the BO evaluator reads (the same snapshot
 * repository and the Business Administration declared-currency reader), derives, and returns the result with the evidence digest. It WRITES
 * NOTHING: no evaluation row, no event, no audit row, no operational mutation, and it imports no ABA, ADI or workflow code. The ADI
 * recommendation producer consumes it through a structural port, so ADI never imports Business Operations.
 */
import {
  BusinessDeclaredCurrencyReader, InventoryPolicyFactsRepository, type TenantContext,
} from '@infinicus/database';
import { deriveCompliantReorderPolicy, type ReorderPolicyDerivation } from './derive.js';
import { buildEvaluationInputs } from './InventoryPolicyEvaluationService.js';
import type { DeclaredCurrencyFact } from './evaluate.js';
import { resolveApprovedRuleSet } from './ruleSet.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ReorderPolicyDerivationRequest { businessId: string; itemId: string; ruleSetVersion: string }
export interface ReorderPolicyDerivationEvidence { snapshotDigest: string; capturedAt: string; windowStartsAt: string; ruleSetVersion: string; evidenceMaxAgeMs: number }
export interface ReorderPolicyDerivationResult { derivation: ReorderPolicyDerivation; evidence: ReorderPolicyDerivationEvidence | null }

export interface ReorderPolicyDerivationDependencies {
  facts: Pick<InventoryPolicyFactsRepository, 'loadSnapshot'>;
  declaredCurrency: Pick<BusinessDeclaredCurrencyReader, 'getCurrent'>;
}

export class ReorderPolicyDerivationService {
  private readonly deps: ReorderPolicyDerivationDependencies;
  constructor(deps: Partial<ReorderPolicyDerivationDependencies> = {}) {
    this.deps = { facts: deps.facts ?? new InventoryPolicyFactsRepository(), declaredCurrency: deps.declaredCurrency ?? new BusinessDeclaredCurrencyReader() };
  }

  async derive(ctx: TenantContext, request: ReorderPolicyDerivationRequest): Promise<ReorderPolicyDerivationResult> {
    if (!UUID.test(request.businessId) || !UUID.test(request.itemId)) {
      return { derivation: { outcome: 'NONE', code: 'EVIDENCE_UNAVAILABLE', detail: 'businessId and itemId must be lowercase UUIDs', reasonCodes: ['TARGET_ID_NOT_UUID'] }, evidence: null };
    }
    const ruleSet = resolveApprovedRuleSet(request.ruleSetVersion); // throws for an unknown/draft/empty version: there is no default
    const snapshot = await this.deps.facts.loadSnapshot(ctx, {
      businessId: request.businessId, inventoryItemId: request.itemId, windowDays: ruleSet.demandWindowDays, demandMovementTypes: ruleSet.demandMovementTypes,
    });
    const declared = await this.deps.declaredCurrency.getCurrent(ctx, request.businessId);
    const declaredFact: DeclaredCurrencyFact = declared.status === 'DECLARED'
      ? { status: 'DECLARED', currency: declared.current.currency, version: declared.current.version }
      : { status: 'UNDECLARED' };
    const derivation = deriveCompliantReorderPolicy({ itemId: request.itemId, snapshot, declaredCurrency: declaredFact, ruleSet });
    const { snapshotDigest } = buildEvaluationInputs(snapshot, declaredFact, ruleSet);
    return { derivation, evidence: { snapshotDigest, capturedAt: snapshot.capturedAt, windowStartsAt: snapshot.windowStartsAt, ruleSetVersion: ruleSet.version, evidenceMaxAgeMs: ruleSet.maxEvidenceAgeMs } };
  }
}
