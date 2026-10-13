/**
 * BO-owned evaluator for `inventory_reorder_policy_update@1` (Block B2b).
 *
 * Business Operations owns operational evaluation truth. This service reads BO facts (inventory item, balance, movements) and the
 * governed declared currency (through the Business Administration read boundary), applies the owner-approved rule set, and appends ONE
 * authoritative evaluation record per dimension through the B2a repository. It authorizes nothing, issues nothing, executes nothing,
 * mutates no operational row, emits no event, and imports no ABA or workflow code. ABA may later VERIFY a stored record through an adapter
 * (B2c); this service never calls ABA and ABA is never the source of truth.
 *
 * What a caller can and cannot do:
 *  - can name: the business, the exact subject (action type, target, FINAL parameters), an approved rule-set version, a correlation id;
 *  - cannot supply: a result, a dimension, thresholds, findings, inputs, a digest, a time. Any such property is refused. `evaluated_at` is
 *    stamped by the database; the subject digest is computed here with the shared contract helper over exactly the persisted subject.
 *
 * Audit: the rows and one platform audit event (bo.inventory_policy_evaluation.requested) commit atomically in the B2a repository.
 *
 * Idempotency model (documented decision): the evaluation is a PURE function of (subject, rule-set version, BO fact snapshot, declared
 * currency). Each call APPENDS four new facts with their own database time; rows are never merged, updated or overwritten, so a later call
 * after the facts changed naturally produces new records. Every row carries `inputs.snapshotDigest` (a digest of the facts, excluding
 * capture times), so a replay of the same facts is recognisably the same snapshot and provably yields the same result. Request-level replay
 * protection (Idempotency-Key) belongs to the HTTP route of B2c; the repository deliberately has no hidden de-duplication.
 */
import { randomUUID } from 'node:crypto';
import {
  BusinessDeclaredCurrencyReader, InventoryPolicyEvaluationRepository, InventoryPolicyFactsRepository,
  type EvaluationJson, type InventoryPolicyEvaluation, type InventoryPolicyFactsSnapshot, type TenantContext,
} from '@infinicus/database';
import { canonicalize, computeGovernanceSubjectDigest, sha256HexOfText, type JsonValue } from '@infinicus/handoff-contracts';
import {
  EVALUATED_DIMENSIONS, SUPPORTED_ACTION, SUPPORTED_TARGET_KIND, evaluateInventoryReorderPolicy, type DeclaredCurrencyFact, type EvaluationSubject,
} from './evaluate.js';
import { INVENTORY_REORDER_POLICY_RULE_SET_ID, resolveApprovedRuleSet, type InventoryReorderRuleSet } from './ruleSet.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The only properties a request may carry. Anything else (result, dimension, thresholds, evaluatedAt, ...) is refused. */
const REQUEST_KEYS = ['businessId', 'actionType', 'target', 'finalParameters', 'ruleSetVersion', 'correlationId'] as const;
export const INVENTORY_POLICY_EVALUATION_REFERENCE_KIND = 'bo_inventory_policy_evaluation';
export const INVENTORY_POLICY_EVALUATION_INPUTS_SCHEMA = 'inventory-policy-evaluation-inputs/1';

export interface EvaluateInventoryReorderPolicyRequest {
  businessId: string;
  actionType: { code: string; schemaVersion: string };
  target: { kind: string; id: string };
  finalParameters: { [key: string]: JsonValue };
  /** An approved rule-set version, named explicitly. There is no default. */
  ruleSetVersion: string;
  correlationId: string;
}

export class InventoryPolicyEvaluationRefusedError extends Error {
  constructor(readonly code: string, detail: string) {
    super(`Inventory policy evaluation refused (${code}): ${detail}`);
    this.name = 'ValidationError';
  }
}

export interface EvaluationReference { kind: typeof INVENTORY_POLICY_EVALUATION_REFERENCE_KIND; id: string; dimension: (typeof EVALUATED_DIMENSIONS)[number] }
export interface InventoryPolicyEvaluationOutcome {
  subjectDigest: string;
  ruleSetVersion: string;
  snapshotDigest: string;
  warehouseId: string | null;
  evaluations: InventoryPolicyEvaluation[];
  references: EvaluationReference[];
}

export interface InventoryPolicyEvaluationDependencies {
  facts: Pick<InventoryPolicyFactsRepository, 'loadSnapshot'>;
  evaluations: Pick<InventoryPolicyEvaluationRepository, 'recordAll'>;
  declaredCurrency: Pick<BusinessDeclaredCurrencyReader, 'getCurrent'>;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const defined = (o: Record<string, unknown>): Record<string, EvaluationJson> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Record<string, EvaluationJson>;

export class InventoryPolicyEvaluationService {
  private readonly deps: InventoryPolicyEvaluationDependencies;

  constructor(deps: Partial<InventoryPolicyEvaluationDependencies> = {}) {
    this.deps = {
      facts: deps.facts ?? new InventoryPolicyFactsRepository(),
      evaluations: deps.evaluations ?? new InventoryPolicyEvaluationRepository(),
      declaredCurrency: deps.declaredCurrency ?? new BusinessDeclaredCurrencyReader(),
    };
  }

  /**
   * `permissionUsed` is the permission the request was authorized under (for the platform audit record written atomically with the
   * evaluation rows); it is supplied by the authenticated route, never by the caller's body.
   */
  async evaluate(ctx: TenantContext, request: EvaluateInventoryReorderPolicyRequest, permissionUsed: string): Promise<InventoryPolicyEvaluationOutcome> {
    if (typeof permissionUsed !== 'string' || permissionUsed.length === 0) throw new InventoryPolicyEvaluationRefusedError('INVALID_REQUEST', 'the authorizing permission is required for the audit record');
    const { subject, ruleSet, businessId, correlationId } = this.validate(request);
    // The digest is computed once, from exactly the subject that is persisted and evaluated.
    let subjectDigest: string;
    try { subjectDigest = computeGovernanceSubjectDigest(subject as never); }
    catch { throw new InventoryPolicyEvaluationRefusedError('SUBJECT_NOT_CANONICAL', 'the subject cannot be canonicalised (non-JSON value in finalParameters)'); }

    const snapshot = await this.deps.facts.loadSnapshot(ctx, {
      businessId, inventoryItemId: subject.target.id, windowDays: ruleSet.demandWindowDays, demandMovementTypes: ruleSet.demandMovementTypes,
    });
    // A record must be bound to a real inventory item (foreign key); an unresolved target has nothing to bind to and fails closed here.
    if (snapshot.item === null) throw new InventoryPolicyEvaluationRefusedError('TARGET_UNRESOLVED', 'the target is not an inventory item of this business');

    const declared = await this.deps.declaredCurrency.getCurrent(ctx, businessId);
    const declaredFact: DeclaredCurrencyFact = declared.status === 'DECLARED'
      ? { status: 'DECLARED', currency: declared.current.currency, version: declared.current.version }
      : { status: 'UNDECLARED' };

    const output = evaluateInventoryReorderPolicy({ subject, snapshot, declaredCurrency: declaredFact, ruleSet });
    const { inputs, snapshotDigest } = this.buildInputs(snapshot, declaredFact, ruleSet);

    const evaluations = await this.deps.evaluations.recordAll(ctx, output.dimensions.map((d) => ({
      businessId,
      inventoryItemId: subject.target.id,
      warehouseId: output.warehouseId,
      dimension: d.dimension,
      result: d.result,
      subject: subject as never,
      subjectDigest,
      ruleSetVersion: ruleSet.version,
      inputs,
      findings: d.findings as unknown as EvaluationJson[],
      requestedByUserId: ctx.userId,
      correlationId,
    })), { permissionUsed });
    return {
      subjectDigest, ruleSetVersion: ruleSet.version, snapshotDigest, warehouseId: output.warehouseId, evaluations,
      references: evaluations.map((e) => ({ kind: INVENTORY_POLICY_EVALUATION_REFERENCE_KIND, id: e.id, dimension: e.dimension as EvaluationReference['dimension'] })),
    };
  }

  private validate(request: EvaluateInventoryReorderPolicyRequest): { subject: EvaluationSubject; ruleSet: InventoryReorderRuleSet; businessId: string; correlationId: string } {
    if (!isPlainObject(request)) throw new InventoryPolicyEvaluationRefusedError('INVALID_REQUEST', 'the request must be an object');
    const extra = Object.keys(request).filter((k) => !(REQUEST_KEYS as readonly string[]).includes(k));
    if (extra.length > 0) throw new InventoryPolicyEvaluationRefusedError('CALLER_SUPPLIED_AUTHORITY', `the caller may not supply: ${extra.join(', ')}`);
    const missing = REQUEST_KEYS.filter((k) => (request as unknown as Record<string, unknown>)[k] === undefined);
    if (missing.length > 0) throw new InventoryPolicyEvaluationRefusedError('INVALID_REQUEST', `missing: ${missing.join(', ')}`);
    if (typeof request.businessId !== 'string' || !UUID.test(request.businessId)) throw new InventoryPolicyEvaluationRefusedError('INVALID_REQUEST', 'businessId must be a lowercase UUID');
    if (typeof request.correlationId !== 'string' || !UUID.test(request.correlationId)) throw new InventoryPolicyEvaluationRefusedError('INVALID_REQUEST', 'correlationId must be a lowercase UUID');
    if (!isPlainObject(request.actionType) || typeof request.actionType.code !== 'string' || typeof request.actionType.schemaVersion !== 'string') {
      throw new InventoryPolicyEvaluationRefusedError('INVALID_REQUEST', 'actionType must be { code, schemaVersion }');
    }
    if (request.actionType.code !== SUPPORTED_ACTION.code) throw new InventoryPolicyEvaluationRefusedError('UNSUPPORTED_ACTION_TYPE', `only ${SUPPORTED_ACTION.code}@${SUPPORTED_ACTION.schemaVersion} is evaluated`);
    if (request.actionType.schemaVersion !== SUPPORTED_ACTION.schemaVersion) throw new InventoryPolicyEvaluationRefusedError('UNSUPPORTED_SCHEMA_VERSION', `only schemaVersion ${SUPPORTED_ACTION.schemaVersion} is evaluated`);
    if (!isPlainObject(request.target) || typeof request.target.kind !== 'string' || typeof request.target.id !== 'string') {
      throw new InventoryPolicyEvaluationRefusedError('INVALID_REQUEST', 'target must be { kind, id }');
    }
    if (request.target.kind !== SUPPORTED_TARGET_KIND) throw new InventoryPolicyEvaluationRefusedError('TARGET_KIND_INVALID', `target.kind must be ${SUPPORTED_TARGET_KIND}`);
    if (!UUID.test(request.target.id)) throw new InventoryPolicyEvaluationRefusedError('TARGET_ID_NOT_UUID', 'target.id must be the inventory item UUID (lowercase)');
    if (!isPlainObject(request.finalParameters)) throw new InventoryPolicyEvaluationRefusedError('INVALID_REQUEST', 'finalParameters must be an object');
    let ruleSet: InventoryReorderRuleSet;
    try { ruleSet = resolveApprovedRuleSet(request.ruleSetVersion); }
    catch (e) { throw new InventoryPolicyEvaluationRefusedError('RULE_SET_NOT_APPROVED', (e as Error).message); }
    return {
      subject: {
        actionType: { code: request.actionType.code, schemaVersion: request.actionType.schemaVersion },
        target: { kind: request.target.kind, id: request.target.id },
        finalParameters: request.finalParameters as { [key: string]: EvaluationJson },
      },
      ruleSet, businessId: request.businessId, correlationId: request.correlationId,
    };
  }

  /** The persisted snapshot of every fact used, with a digest that ignores capture times so an identical fact set has an identical digest. */
  private buildInputs(snapshot: InventoryPolicyFactsSnapshot, declared: DeclaredCurrencyFact, ruleSet: InventoryReorderRuleSet): { inputs: { [key: string]: EvaluationJson }; snapshotDigest: string } {
    return buildEvaluationInputs(snapshot, declared, ruleSet);
  }
}

/**
 * The persisted snapshot of every fact used by an evaluation, with a digest that ignores capture times (an identical fact set has an identical
 * digest). One definition: the evaluator persists it, and the read-only ADI derivation cites the same digest as its evidence reference.
 */
export function buildEvaluationInputs(snapshot: InventoryPolicyFactsSnapshot, declared: DeclaredCurrencyFact, ruleSet: InventoryReorderRuleSet): { inputs: { [key: string]: EvaluationJson }; snapshotDigest: string } {
  const parameters = defined({
    maxChangeReorderPointPct: ruleSet.maxChangeReorderPointPct, maxChangeReorderQuantityPct: ruleSet.maxChangeReorderQuantityPct, orderValueCap: ruleSet.orderValueCap,
    orderValueCapCurrency: ruleSet.orderValueCapCurrency, maxChangeOrderValuePctOfCap: ruleSet.maxChangeOrderValuePctOfCap, maxImpliedStockUnits: ruleSet.maxImpliedStockUnits,
    leadTimeDays: ruleSet.leadTimeDays, safetyFactor: ruleSet.safetyFactor, maxCoverDays: ruleSet.maxCoverDays, firstConfigurationAllowed: ruleSet.firstConfigurationAllowed,
    demandWindowDays: ruleSet.demandWindowDays, demandMovementTypes: [...ruleSet.demandMovementTypes], minDemandObservations: ruleSet.minDemandObservations,
    maxEvidenceAgeMs: ruleSet.maxEvidenceAgeMs,
  });
  const facts: { [key: string]: EvaluationJson } = {
    item: snapshot.item === null ? null : { id: snapshot.item.id, status: snapshot.item.status, unitOfMeasure: snapshot.item.unitOfMeasure },
    balances: snapshot.balances.map((b) => ({ id: b.id, warehouseId: b.warehouseId, reorderPoint: b.reorderPoint, reorderQuantity: b.reorderQuantity })),
    latestReceipt: snapshot.latestReceipt === null ? null : { ...snapshot.latestReceipt },
    demand: { count: snapshot.demand.count, sumOfMagnitudes: snapshot.demand.sumOfMagnitudes, movementTypes: [...snapshot.demandMovementTypes] },
    declaredCurrency: declared.status === 'DECLARED' ? { status: 'DECLARED', currency: declared.currency, version: declared.version } : { status: 'UNDECLARED' },
  };
  const snapshotDigest = `sha256:${sha256HexOfText(canonicalize({ ruleSetVersion: ruleSet.version, facts }))}`;
  return {
    snapshotDigest,
    inputs: {
      schema: INVENTORY_POLICY_EVALUATION_INPUTS_SCHEMA,
      ruleSet: { id: INVENTORY_REORDER_POLICY_RULE_SET_ID, version: ruleSet.version, parameters },
      capturedAt: snapshot.capturedAt,
      window: { startsExclusive: snapshot.windowStartsAt, endsInclusive: snapshot.capturedAt, days: snapshot.windowDays },
      facts,
      snapshotDigest,
    },
  };
}

/** A correlation id for callers that have none; evaluation records require one. */
export const newEvaluationCorrelationId = (): string => randomUUID();
