/**
 * Business Operations' implementation of the shared `GovernanceEvidenceVerifier` port (P0-5 Block B2c).
 *
 * ABA asks, for each required governance dimension, whether a `{kind, id}` reference is an AUTHORITATIVE, scope-correct, current
 * evaluation that PASSED for the exact modified parameters. This adapter answers from the Business Operations evaluation record
 * (`business_operations.inventory_policy_evaluations`, append-only, written only by the B2b evaluator) - and only from it.
 *
 * It is an evidence adapter, nothing more: it grants no approval, issues no package, executes nothing, mutates nothing and emits nothing.
 * It is registered at the API composition root; ABA depends on the port only and never imports this file or any BO repository.
 *
 * VERIFIED requires ALL of: the reference kind is `bo_inventory_policy_evaluation`; the record exists in the caller's tenant, workspace and
 * business; its dimension is the requested one and is one of the four evaluated dimensions; its action type, schema version and target equal
 * the request; its stored subject digest equals the digest recomputed here from the requested final parameters; its rule-set version is an
 * approved, effective one; its result is PASSED; it was produced by the BO evaluator (inputs schema and rule-set identity match its row);
 * and, on the DATABASE clock, it was evaluated at or after the modification decision (`modifiedAt`), not in the future, and no longer ago
 * than the rule set's maximum evidence age (24 hours for v1.0.0, inclusive). Anything else is REFUSED; FAILED and INDETERMINATE are never
 * converted. A thrown error also becomes REFUSED (never VERIFIED). All times are compared at millisecond precision, the contract's.
 */
import { InventoryPolicyEvaluationRepository, type InventoryPolicyEvaluation } from '@infinicus/database';
import {
  canonicalize, computeGovernanceSubjectDigest,
  type GovernanceEvidenceRequest, type GovernanceEvidenceVerdict, type GovernanceEvidenceVerifier, type JsonValue,
} from '@infinicus/handoff-contracts';
import { EVALUATED_DIMENSIONS, SUPPORTED_ACTION, SUPPORTED_TARGET_KIND } from './evaluate.js';
import { INVENTORY_REORDER_POLICY_RULE_SET_ID, resolveApprovedRuleSet } from './ruleSet.js';
import { INVENTORY_POLICY_EVALUATION_INPUTS_SCHEMA, INVENTORY_POLICY_EVALUATION_REFERENCE_KIND } from './InventoryPolicyEvaluationService.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MS_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const BO_EVIDENCE_AUTHORITATIVE_SOURCE = Object.freeze({ layer: 'BUSINESS_OPERATIONS', component: 'InventoryPolicyEvaluationService' });

export interface BoGovernanceEvidenceVerifierDependencies {
  evaluations: Pick<InventoryPolicyEvaluationRepository, 'getByIdWithDatabaseNow'>;
}

const refuse = (reason: string): GovernanceEvidenceVerdict => ({ status: 'REFUSED', reason });
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export class BoGovernanceEvidenceVerifier implements GovernanceEvidenceVerifier {
  private readonly deps: BoGovernanceEvidenceVerifierDependencies;

  constructor(deps: Partial<BoGovernanceEvidenceVerifierDependencies> = {}) {
    this.deps = { evaluations: deps.evaluations ?? new InventoryPolicyEvaluationRepository() };
  }

  async verify(request: GovernanceEvidenceRequest): Promise<GovernanceEvidenceVerdict> {
    try {
      return await this.verifyUnguarded(request);
    } catch (error) {
      return refuse(`evidence could not be verified: ${error instanceof Error ? error.name : 'error'}`);
    }
  }

  private async verifyUnguarded(request: GovernanceEvidenceRequest): Promise<GovernanceEvidenceVerdict> {
    if (!isObject(request) || !isObject(request.evidenceRef) || !isObject(request.subject)) return refuse('malformed verification request');
    const { tenantId, workspaceId, businessId, actorUserId, modifiedAt, dimension, evidenceRef, subject } = request;
    for (const [name, value] of [['tenantId', tenantId], ['workspaceId', workspaceId], ['businessId', businessId], ['actorUserId', actorUserId]] as const) {
      if (typeof value !== 'string' || !UUID.test(value)) return refuse(`${name} must be a lowercase UUID`);
    }
    if (typeof modifiedAt !== 'string' || !MS_UTC.test(modifiedAt) || Number.isNaN(Date.parse(modifiedAt))) return refuse('modifiedAt must be a millisecond UTC timestamp');
    if (evidenceRef.kind !== INVENTORY_POLICY_EVALUATION_REFERENCE_KIND) return refuse(`unsupported evidence kind (expected ${INVENTORY_POLICY_EVALUATION_REFERENCE_KIND})`);
    if (typeof evidenceRef.id !== 'string' || !UUID.test(evidenceRef.id)) return refuse('the evidence reference id must be a lowercase UUID');
    if (!(EVALUATED_DIMENSIONS as readonly string[]).includes(dimension)) return refuse(`dimension ${String(dimension)} is not an evaluated dimension`);
    if (!isObject(subject.actionType) || subject.actionType.code !== SUPPORTED_ACTION.code || subject.actionType.schemaVersion !== SUPPORTED_ACTION.schemaVersion) {
      return refuse(`only ${SUPPORTED_ACTION.code}@${SUPPORTED_ACTION.schemaVersion} evidence is supported`);
    }
    if (!isObject(subject.target) || subject.target.kind !== SUPPORTED_TARGET_KIND || typeof subject.target.id !== 'string' || !UUID.test(subject.target.id)) {
      return refuse('the target must be an inventory item identified by a lowercase UUID');
    }
    if (!isObject(subject.finalParameters)) return refuse('finalParameters must be an object');

    const expectedSubject = {
      actionType: { code: subject.actionType.code, schemaVersion: subject.actionType.schemaVersion },
      target: { kind: subject.target.kind, id: subject.target.id },
      finalParameters: subject.finalParameters as Record<string, JsonValue>,
    };
    let expectedDigest: string;
    try { expectedDigest = computeGovernanceSubjectDigest(expectedSubject as never); } catch { return refuse('the subject cannot be canonicalised'); }

    // The lookup itself is scoped to the caller's tenant, workspace and business: another scope's record is indistinguishable from a missing one.
    let found: { evaluation: InventoryPolicyEvaluation; databaseNow: string };
    try {
      found = await this.deps.evaluations.getByIdWithDatabaseNow({ tenantId, workspaceId, userId: actorUserId }, businessId, evidenceRef.id);
    } catch (error) {
      if (error instanceof Error && error.name === 'NotFoundError') return refuse('no such evaluation record in this tenant, workspace and business');
      throw error;
    }
    const ev = found.evaluation;
    if (ev.tenantId !== tenantId || ev.workspaceId !== workspaceId || ev.businessId !== businessId || ev.id !== evidenceRef.id) return refuse('the evaluation record is outside the requested scope');
    if (ev.dimension !== dimension) return refuse(`the record evaluates ${ev.dimension}, not ${dimension}`);
    if (ev.inventoryItemId !== subject.target.id) return refuse('the record belongs to a different inventory item');

    // Exact subject binding: the stored digest AND the stored subject must equal what is being authorized now.
    if (ev.subjectDigest !== expectedDigest) return refuse('the record was evaluated for different parameters (subject digest mismatch)');
    if (canonicalize(ev.subject as unknown as JsonValue) !== canonicalize(expectedSubject as unknown as JsonValue)) return refuse('the stored subject differs from the requested subject');

    let ruleSet;
    try { ruleSet = resolveApprovedRuleSet(ev.ruleSetVersion); } catch { return refuse(`rule-set version ${ev.ruleSetVersion} is not approved and effective`); }

    // Provenance: the BO evaluator stamps this inputs envelope; a record without it was not produced by the evaluator.
    const inputs = ev.inputs as unknown;
    if (!isObject(inputs) || inputs.schema !== INVENTORY_POLICY_EVALUATION_INPUTS_SCHEMA || !isObject(inputs.ruleSet)
      || inputs.ruleSet.id !== INVENTORY_REORDER_POLICY_RULE_SET_ID || inputs.ruleSet.version !== ev.ruleSetVersion || typeof inputs.snapshotDigest !== 'string') {
      return refuse('the record does not carry the BO evaluator input snapshot');
    }

    if (ev.result !== 'PASSED') return refuse(`the ${ev.dimension} evaluation result is ${ev.result}; only PASSED can be evidence`);

    if (!MS_UTC.test(ev.evaluatedAt) || !MS_UTC.test(found.databaseNow)) return refuse('the evaluation time is not authoritative');
    const evaluatedMs = Date.parse(ev.evaluatedAt);
    const nowMs = Date.parse(found.databaseNow);
    if (evaluatedMs < Date.parse(modifiedAt)) return refuse('the evaluation predates the modification decision, so it does not cover it');
    if (evaluatedMs > nowMs) return refuse('the evaluation is dated after the database clock');
    if (nowMs - evaluatedMs > ruleSet.maxEvidenceAgeMs) return refuse(`the evaluation is older than the maximum evidence age of ${ruleSet.maxEvidenceAgeMs} ms`);

    return {
      status: 'VERIFIED', dimension: ev.dimension as typeof EVALUATED_DIMENSIONS[number], result: 'PASSED', evaluatedAt: ev.evaluatedAt,
      evidenceRef: { kind: INVENTORY_POLICY_EVALUATION_REFERENCE_KIND, id: ev.id },
      authoritativeSource: { ...BO_EVIDENCE_AUTHORITATIVE_SOURCE },
      sourceVersion: `${ev.ruleSetVersion}|${inputs.snapshotDigest}`,
    };
  }
}
