// ADI structured proposed-action recommendation (AC-1). ADI -> ABA.
//
// The existing ADI -> ABA handoff (adi-to-aba.ts, BUILD-14) carries a published recommendation's narrative (summary, rationales, steps,
// confidence, risks, evidence). It carries no machine-readable action. This contract adds that one missing fact ADDITIVELY and without a
// second recommendation record: a recommendation version may carry ONE rationale with code `proposed_action` whose `evidence_reference`
// holds a {@link ProposedActionRecommendation}. Narrative recommendations without it are unchanged.
//
// What it is NOT: it is not an approval, an authorization, an AuthorizedActionPackage or an execution instruction. ABA alone decides, may
// modify, and owns the final parameters; the original ADI proposal is only ever the `proposed` half of ABA's decision-time capture. BO
// executes only an issued AuthorizedActionPackage. The validator below is fail-closed: anything it cannot positively verify is a problem.
//
// The action vocabulary is the canonical one (canonical-actions.ts); this contract invents no action type, target kind or parameter.

import { BI_BDT_EVIDENCE_REQUIRED, CANONICAL_ACTION_TYPES, actionTypeKey } from './authorized-action-package/canonical-actions';
import { checkParameterValue } from './authorized-action-package/action-types';
import type { JsonValue } from './authorized-action-package/types';

export const ADI_PROPOSED_ACTION_CONTRACT = 'adi-proposed-action/1' as const;
/** `recommendation_rationales.rationale_code` under which the structured proposal is stored. */
export const PROPOSED_ACTION_RATIONALE_CODE = 'proposed_action' as const;
export const PROPOSED_ACTION_METHODS = ['DETERMINISTIC_RULE'] as const;
export type ProposedActionMethod = (typeof PROPOSED_ACTION_METHODS)[number];

/** Evidence kinds of the first action: the BO fact snapshot the proposal was derived from, and the BO evaluation records of that exact proposal. */
export const BO_FACTS_REFERENCE_KIND = 'bo_inventory_policy_facts' as const;
export const BO_EVALUATION_REFERENCE_KIND = 'bo_inventory_policy_evaluation' as const;
/** AC-2 Block 7: a reference to the published BI insight package version the proposal was derived from (`id` = the version id). */
export const BI_EVIDENCE_REFERENCE_KIND = 'bi_inventory_evidence' as const;
/** AC-2 Block 7: a reference to the published BDT snapshot (`id` = the snapshot id) whose modeled state the proposal was derived from. */
export const BDT_STATE_REFERENCE_KIND = 'bdt_inventory_item_state' as const;

export interface ProposedActionEvidenceReference {
  /** What the reference points at, e.g. `bo_inventory_policy_facts`. */
  kind: string;
  /** Digest of the exact fact set used (`sha256:<hex>`), so the evidence can be re-derived and compared. */
  digest: string;
  /** Optional identifier of the referenced record (required for a BO evaluation record). */
  id?: string;
  /** The governance dimension an evaluation record covers (required for a BO evaluation record). */
  dimension?: string;
}

export interface ProposedActionRecommendation {
  contract: typeof ADI_PROPOSED_ACTION_CONTRACT;
  actionType: { code: string; schemaVersion: string };
  target: { kind: string; id: string };
  /** The proposed parameter set. Becomes ABA's `proposed` half of the capture; ABA owns the final set. */
  proposedParameters: Record<string, JsonValue>;
  /** The state the proposal was derived from (a reference plus the values at derivation time), or null when none applies. */
  currentState: { reference: { kind: string; id: string }; parameters: Record<string, JsonValue> } | null;
  evidenceReferences: ProposedActionEvidenceReference[];
  reasoning: { summary: string; basis: string[] };
  /**
   * Honest confidence: a deterministic rule produces compliance with a rule set, not a statistical forecast. `value` is null unless a
   * governed model supplies a calibrated probability; `kind` says what the statement is.
   */
  confidence: { kind: 'RULE_COMPLIANCE' | 'CALIBRATED_PROBABILITY'; value: number | null; statement: string };
  /** Constraints the proposal was required to satisfy (rule-set version and bounds). */
  constraints: Record<string, JsonValue>;
  provenance: { producer: string; producerVersion: string; method: ProposedActionMethod; ruleSetVersion: string; producedAt: string };
}

const KEYS = ['contract', 'actionType', 'target', 'proposedParameters', 'currentState', 'evidenceReferences', 'reasoning', 'confidence', 'constraints', 'provenance'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO_MS_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonBlank = (v: unknown, max = 500): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

/** Problems with a candidate proposal (empty = valid). Pure; fail-closed; never throws. */
export function validateProposedActionRecommendation(value: unknown): string[] {
  const p: string[] = [];
  if (!isObject(value)) return ['the proposal must be an object'];
  const extra = Object.keys(value).filter((k) => !(KEYS as readonly string[]).includes(k));
  if (extra.length > 0) p.push(`unknown properties: ${extra.join(', ')}`);
  for (const k of KEYS) if (!(k in value)) p.push(`missing property: ${k}`);
  if (p.length > 0) return p;
  if (value.contract !== ADI_PROPOSED_ACTION_CONTRACT) p.push(`contract must be ${ADI_PROPOSED_ACTION_CONTRACT}`);

  const at = value.actionType;
  let canonical: (typeof CANONICAL_ACTION_TYPES)[number] | undefined;
  if (!isObject(at) || !nonBlank(at.code, 100) || !nonBlank(at.schemaVersion, 50)) p.push('actionType must be { code, schemaVersion }');
  else {
    canonical = CANONICAL_ACTION_TYPES.find((c) => c.code === at.code && c.schemaVersion === at.schemaVersion);
    if (!canonical) p.push(`action type ${String(at.code)}@${String(at.schemaVersion)} is not in the canonical vocabulary`);
  }

  const tg = value.target;
  if (!isObject(tg) || !nonBlank(tg.kind, 100) || typeof tg.id !== 'string') p.push('target must be { kind, id }');
  else {
    if (canonical && !canonical.targetKinds.includes(tg.kind as string)) p.push(`target kind ${String(tg.kind)} is not allowed for ${canonical.code}@${canonical.schemaVersion}`);
    if (!UUID.test(tg.id as string)) p.push('target.id must be a lowercase UUID');
  }

  const params = value.proposedParameters;
  if (!isObject(params)) p.push('proposedParameters must be an object');
  else if (canonical) {
    for (const name of Object.keys(params)) {
      const spec = Object.prototype.hasOwnProperty.call(canonical.parameters, name) ? canonical.parameters[name] : undefined;
      if (!spec) { p.push(`parameter ${name} is not declared by ${canonical.code}@${canonical.schemaVersion}`); continue; }
      for (const m of checkParameterValue(spec, params[name] as JsonValue)) p.push(`parameter ${name} ${m}`);
    }
    for (const [name, spec] of Object.entries(canonical.parameters)) if (spec.required && !(name in params)) p.push(`required parameter ${name} is missing`);
  }

  const cs = value.currentState;
  if (cs !== null) {
    if (!isObject(cs) || !isObject(cs.reference) || !nonBlank(cs.reference.kind, 100) || !nonBlank(cs.reference.id, 100) || !isObject(cs.parameters)) p.push('currentState must be null or { reference: { kind, id }, parameters }');
  }

  const ev = value.evidenceReferences;
  if (!Array.isArray(ev) || ev.length === 0) p.push('at least one evidence reference is required');
  else for (const [i, e] of ev.entries()) {
    if (!isObject(e) || !nonBlank(e.kind, 100) || typeof e.digest !== 'string' || !DIGEST.test(e.digest)) { p.push(`evidenceReferences[${i}] must carry a kind and a sha256 digest`); continue; }
    if ((e.kind === BI_EVIDENCE_REFERENCE_KIND || e.kind === BDT_STATE_REFERENCE_KIND) && (typeof e.id !== 'string' || !UUID.test(e.id))) p.push(`evidenceReferences[${i}] (${String(e.kind)}) must carry a lowercase UUID id`);
    if (e.kind === BO_EVALUATION_REFERENCE_KIND && (typeof e.id !== 'string' || !UUID.test(e.id) || !nonBlank(e.dimension, 100))) p.push(`evidenceReferences[${i}] (a BO evaluation) must carry a lowercase UUID id and a dimension`);
  }

  const rs = value.reasoning;
  if (!isObject(rs) || !nonBlank(rs.summary, 1000) || !Array.isArray(rs.basis) || rs.basis.length === 0 || rs.basis.some((b) => !nonBlank(b, 500))) p.push('reasoning must carry a summary and at least one basis statement');

  const cf = value.confidence;
  if (!isObject(cf) || (cf.kind !== 'RULE_COMPLIANCE' && cf.kind !== 'CALIBRATED_PROBABILITY') || !nonBlank(cf.statement, 500)) p.push('confidence must carry a kind and a statement');
  else if (cf.kind === 'CALIBRATED_PROBABILITY' && !(typeof cf.value === 'number' && Number.isFinite(cf.value) && cf.value >= 0 && cf.value <= 1)) p.push('a calibrated probability must be a number in [0, 1]');
  else if (cf.kind === 'RULE_COMPLIANCE' && cf.value !== null) p.push('rule-compliance confidence must not claim a numeric probability');

  if (!isObject(value.constraints)) p.push('constraints must be an object');

  const pv = value.provenance;
  if (!isObject(pv) || !nonBlank(pv.producer, 200) || !nonBlank(pv.producerVersion, 50) || !nonBlank(pv.ruleSetVersion, 100)
    || !(PROPOSED_ACTION_METHODS as readonly unknown[]).includes(pv.method) || typeof pv.producedAt !== 'string' || !ISO_MS_UTC.test(pv.producedAt) || Number.isNaN(Date.parse(pv.producedAt))) {
    p.push('provenance must carry producer, producerVersion, a known method, ruleSetVersion and a millisecond UTC producedAt');
  }
  return p;
}

/** Equality of the machine-readable action a capture claims with the one ADI proposed (same type, target and exact parameter set). */
export function proposalMatchesCapture(
  proposal: Pick<ProposedActionRecommendation, 'actionType' | 'target' | 'proposedParameters'>,
  capture: { actionType: { code: string; schemaVersion: string }; target: { kind: string; id: string }; proposedParameters: Record<string, JsonValue> },
): string[] {
  const p: string[] = [];
  if (proposal.actionType.code !== capture.actionType.code || proposal.actionType.schemaVersion !== capture.actionType.schemaVersion) p.push('action type differs from the ADI proposal');
  if (proposal.target.kind !== capture.target.kind || proposal.target.id !== capture.target.id) p.push('target differs from the ADI proposal');
  const a = Object.keys(proposal.proposedParameters).sort(); const b = Object.keys(capture.proposedParameters).sort();
  if (a.length !== b.length || a.some((k, i) => k !== b[i]) || a.some((k) => proposal.proposedParameters[k] !== capture.proposedParameters[k])) p.push('proposed parameters differ from the ADI proposal');
  return p;
}

/** The BO evaluation records a proposal cites, as `{ kind, id, dimension }` (the references BO resolves its compare-and-set baseline from). */
export function boEvaluationReferences(proposal: Pick<ProposedActionRecommendation, 'evidenceReferences'>): { kind: string; id: string; dimension: string }[] {
  return proposal.evidenceReferences.filter((e) => e.kind === BO_EVALUATION_REFERENCE_KIND).map((e) => ({ kind: e.kind, id: e.id as string, dimension: e.dimension as string }));
}

/**
 * First-action evidence completeness (owner ruling 1 and 2): the proposal must cite the fact snapshot it was derived from AND exactly one BO
 * evaluation record per governance dimension the canonical action type declares, all bound to ONE snapshot digest (the baseline the proposal was
 * derived and evaluated against). Dimensions come from the canonical contract, never from a local list. Empty = complete.
 */
export function proposalEvidenceProblems(proposal: ProposedActionRecommendation): string[] {
  const p: string[] = [];
  const canonical = CANONICAL_ACTION_TYPES.find((c) => c.code === proposal.actionType.code && c.schemaVersion === proposal.actionType.schemaVersion);
  if (!canonical) return [`action type ${proposal.actionType.code}@${proposal.actionType.schemaVersion} is not canonical`];
  const wanted = new Set<string>(Object.values(canonical.governanceImpact).flat());
  const facts = proposal.evidenceReferences.filter((e) => e.kind === BO_FACTS_REFERENCE_KIND);
  if (facts.length !== 1) p.push(`exactly one ${BO_FACTS_REFERENCE_KIND} reference is required`);
  const evals = proposal.evidenceReferences.filter((e) => e.kind === BO_EVALUATION_REFERENCE_KIND);
  const seen = new Set<string>();
  for (const e of evals) { if (e.dimension === undefined || seen.has(e.dimension) || !wanted.has(e.dimension)) p.push(`unexpected or repeated evaluation dimension ${String(e.dimension)}`); else seen.add(e.dimension); }
  for (const d of wanted) if (!seen.has(d)) p.push(`no BO evaluation reference for ${d}`);
  if (facts.length === 1 && evals.some((e) => e.digest !== facts[0].digest)) p.push('the evaluation records and the fact snapshot do not carry the same digest');
  if (BI_BDT_EVIDENCE_REQUIRED.has(actionTypeKey(canonical.code, canonical.schemaVersion))) {
    for (const kind of [BI_EVIDENCE_REFERENCE_KIND, BDT_STATE_REFERENCE_KIND]) {
      const refs = proposal.evidenceReferences.filter((e) => e.kind === kind);
      if (refs.length !== 1) p.push(`exactly one ${kind} reference is required (the principal path consumes governed BI/BDT evidence)`);
      else if (facts.length === 1 && refs[0].digest !== facts[0].digest) p.push(`the ${kind} reference and the fact snapshot do not carry the same digest`);
    }
  }
  return p;
}
