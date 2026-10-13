/**
 * Read-only Business Operations source of the facts Business Intelligence turns into analytical evidence for the first action (AC-2 Block 5).
 * It loads exactly what the BO evaluator and the derivation read (one consistent tenant snapshot, database clock, declared currency) plus the balance's
 * current quantity, and returns them with the SAME snapshot digest the evaluation records and the ADI proposal carry, so BI evidence, the evaluation
 * records and the proposal can be proven to describe the same facts. It WRITES NOTHING and imports no BI, ADI, ABA or workflow code: BI reaches it
 * through a structural port joined at the composition root.
 */
import { BusinessDeclaredCurrencyReader, InventoryBalanceRepository, InventoryPolicyFactsRepository, type TenantContext } from '@infinicus/database';
import { Decimal } from './decimal.js';
import { buildEvaluationInputs } from './InventoryPolicyEvaluationService.js';
import type { DeclaredCurrencyFact } from './evaluate.js';
import { resolveApprovedRuleSet } from './ruleSet.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface InventoryEvidenceFactsRequest { businessId: string; itemId: string; ruleSetVersion: string }

export interface InventoryEvidenceFacts {
  businessId: string;
  itemId: string;
  ruleSetVersion: string;
  /** The digest of the fact set, identical to the one the BO evaluation records and the ADI proposal cite. */
  snapshotDigest: string;
  capturedAt: string;
  windowStartsAt: string;
  windowDays: number;
  evidenceMaxAgeMs: number;
  demandMovementTypes: string[];
  /** Present only when the item has exactly ONE balance (an ambiguous balance is never guessed). */
  balance: { id: string; warehouseId: string; quantityOnHand: string; reorderPoint: string; reorderQuantity: string } | null;
  balanceCount: number;
  /**
   * The latest receipt. `cost` / `costCurrency` are the receipt's stated per-unit cost and its currency; `costCurrencyMatchesBusinessCurrency` is computed HERE
   * (Business Operations holds the governed currency) so that consumers never need, copy or compare the business currency themselves; null when either side is unknown.
   */
  latestReceipt: { movementId: string; occurredAt: string; cost: string | null; costCurrency: string | null; costCurrencyMatchesBusinessCurrency: boolean | null } | null;
  demand: { count: number; sumOfMagnitudes: string };
}

export type InventoryEvidenceFactsResult =
  | { outcome: 'FACTS'; facts: InventoryEvidenceFacts }
  | { outcome: 'UNAVAILABLE'; code: 'TARGET_NOT_FOUND' | 'INVALID_REQUEST'; detail: string };

export interface InventoryEvidenceFactsDependencies {
  facts: Pick<InventoryPolicyFactsRepository, 'loadSnapshot'>;
  declaredCurrency: Pick<BusinessDeclaredCurrencyReader, 'getCurrent'>;
  balances: Pick<InventoryBalanceRepository, 'findByItemAndWarehouse'>;
}

export class InventoryEvidenceFactsService {
  private readonly deps: InventoryEvidenceFactsDependencies;
  constructor(deps: Partial<InventoryEvidenceFactsDependencies> = {}) {
    this.deps = { facts: deps.facts ?? new InventoryPolicyFactsRepository(), declaredCurrency: deps.declaredCurrency ?? new BusinessDeclaredCurrencyReader(), balances: deps.balances ?? new InventoryBalanceRepository() };
  }

  async load(ctx: TenantContext, request: InventoryEvidenceFactsRequest): Promise<InventoryEvidenceFactsResult> {
    if (!UUID.test(request.businessId) || !UUID.test(request.itemId)) return { outcome: 'UNAVAILABLE', code: 'INVALID_REQUEST', detail: 'businessId and itemId must be lowercase UUIDs' };
    let ruleSet: ReturnType<typeof resolveApprovedRuleSet>;
    try { ruleSet = resolveApprovedRuleSet(request.ruleSetVersion); } // an unknown / draft version: there is no default
    catch { return { outcome: 'UNAVAILABLE', code: 'INVALID_REQUEST', detail: `rule set ${request.ruleSetVersion} is not an approved version` }; }
    const snapshot = await this.deps.facts.loadSnapshot(ctx, {
      businessId: request.businessId, inventoryItemId: request.itemId, windowDays: ruleSet.demandWindowDays, demandMovementTypes: ruleSet.demandMovementTypes,
    });
    if (snapshot.item === null) return { outcome: 'UNAVAILABLE', code: 'TARGET_NOT_FOUND', detail: 'the item is not an inventory item of this business' };
    const declared = await this.deps.declaredCurrency.getCurrent(ctx, request.businessId);
    const declaredFact: DeclaredCurrencyFact = declared.status === 'DECLARED'
      ? { status: 'DECLARED', currency: declared.current.currency, version: declared.current.version }
      : { status: 'UNDECLARED' };
    const { snapshotDigest } = buildEvaluationInputs(snapshot, declaredFact, ruleSet);

    let balance: InventoryEvidenceFacts['balance'] = null;
    if (snapshot.balances.length === 1) {
      const only = snapshot.balances[0];
      const row = await this.deps.balances.findByItemAndWarehouse(ctx, request.itemId, only.warehouseId);
      const quantity = Decimal.fromNumber(row.quantityOnHand);
      if (row.id === only.id && row.businessId === request.businessId && quantity !== null) {
        balance = { id: only.id, warehouseId: only.warehouseId, quantityOnHand: quantity.toString(), reorderPoint: only.reorderPoint, reorderQuantity: only.reorderQuantity };
      }
    }
    const declaredCurrency = declaredFact.status === 'DECLARED' ? declaredFact.currency : null;
    const receipt = snapshot.latestReceipt;
    return {
      outcome: 'FACTS',
      facts: {
        businessId: request.businessId, itemId: request.itemId, ruleSetVersion: ruleSet.version, snapshotDigest,
        capturedAt: snapshot.capturedAt, windowStartsAt: snapshot.windowStartsAt, windowDays: snapshot.windowDays, evidenceMaxAgeMs: ruleSet.maxEvidenceAgeMs,
        demandMovementTypes: [...snapshot.demandMovementTypes],
        balance, balanceCount: snapshot.balances.length,
        latestReceipt: receipt === null ? null : {
          movementId: receipt.movementId, occurredAt: receipt.occurredAt, cost: receipt.unitCost, costCurrency: receipt.unitCostCurrency,
          costCurrencyMatchesBusinessCurrency: declaredCurrency === null || receipt.unitCostCurrency === null ? null : declaredCurrency === receipt.unitCostCurrency,
        },
        demand: { count: snapshot.demand.count, sumOfMagnitudes: snapshot.demand.sumOfMagnitudes },
      },
    };
  }
}
