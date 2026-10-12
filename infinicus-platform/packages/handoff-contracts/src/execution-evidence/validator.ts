import { SUPPORTED_AAP_CANONICAL_VERSIONS } from '../authorized-action-package/types';
import { computeExecutionEvidenceDigest } from './digest';
import {
  EXECUTION_AUTHORITY_VERDICTS, EXECUTION_EVIDENCE_CONTRACT_VERSION, EXECUTION_EVIDENCE_DIGEST_ALGORITHM, EXECUTION_EVIDENCE_KIND,
  EXECUTION_MUTATION_RESULTS, EXECUTION_OUTCOMES,
} from './types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const MS_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const MAX_EXECUTION_EVIDENCE_BYTES = 256 * 1024;

/** Effectiveness vocabulary: an execution fact never carries it, at any depth (matched on the lower-cased key without separators). */
const EFFECTIVENESS_KEY = /(effectiv|improv|impact|benefit|uplift|expectedresult|successrate|outcomeverified|outcomeobserved|outcomestate|learned|learning)|^(effect|roi|learn)/;
const CREDENTIAL_KEY = /(^|[_-])(password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|session[_-]?secret)($|[_-])/i;

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const exactKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => own.includes(k));
};
const ts = (v: unknown): v is string => typeof v === 'string' && MS_UTC.test(v) && !Number.isNaN(Date.parse(v));
const uuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const text = (v: unknown, max = 200): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const posInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;

function scanKeys(value: unknown, path: string, problems: string[]): void {
  if (Array.isArray(value)) { value.forEach((v, i) => scanKeys(v, `${path}[${i}]`, problems)); return; }
  if (!isObject(value)) return;
  for (const [k, v] of Object.entries(value)) {
    if (EFFECTIVENESS_KEY.test(k.toLowerCase().replace(/[_-]/g, ''))) problems.push(`${path}.${k}: an execution fact cannot carry outcome-effectiveness vocabulary`);
    if (CREDENTIAL_KEY.test(k)) problems.push(`${path}.${k}: credential-like keys are not allowed`);
    scanKeys(v, `${path}.${k}`, problems);
  }
}

/** Validates everything except the integrity block. Returns the list of problems (empty = valid). */
export function validateExecutionEvidenceBody(input: unknown): string[] {
  const p: string[] = [];
  const bad = (m: string): void => { p.push(m); };
  if (!isObject(input)) return ['the evidence must be an object'];
  if (!exactKeys(input, ['contractVersion', 'evidenceKind', 'identity', 'timing', 'authority', 'mutation', 'preconditions', 'boundaries', 'outcome', 'lineage'])) bad('the evidence has missing or unknown top-level keys');
  if (input.contractVersion !== EXECUTION_EVIDENCE_CONTRACT_VERSION) bad(`contractVersion must be ${EXECUTION_EVIDENCE_CONTRACT_VERSION}`);
  if (input.evidenceKind !== EXECUTION_EVIDENCE_KIND) bad(`evidenceKind must be ${EXECUTION_EVIDENCE_KIND}`);

  const id = input.identity;
  if (!isObject(id) || !exactKeys(id, ['executionId', 'packageId', 'packageVersion', 'packageDigest', 'claimId', 'receiptId', 'scope', 'actionType', 'target'])) bad('identity has missing or unknown keys');
  else {
    for (const k of ['executionId', 'packageId', 'claimId', 'receiptId'] as const) if (!uuid(id[k])) bad(`identity.${k} must be a lowercase UUID`);
    if (!posInt(id.packageVersion)) bad('identity.packageVersion must be an integer >= 1');
    if (typeof id.packageDigest !== 'string' || !DIGEST.test(id.packageDigest)) bad('identity.packageDigest must be sha256:<64 hex>');
    const s = id.scope;
    if (!isObject(s) || !exactKeys(s, ['tenantId', 'workspaceId', 'businessId']) || ![s.tenantId, s.workspaceId, s.businessId].every(uuid)) bad('identity.scope must be exactly tenantId, workspaceId, businessId (UUIDs)');
    const a = id.actionType;
    if (!isObject(a) || !exactKeys(a, ['code', 'schemaVersion']) || !text(a.code) || !text(a.schemaVersion)) bad('identity.actionType must be exactly code and schemaVersion');
    const t = id.target;
    if (!isObject(t) || !exactKeys(t, ['kind', 'id']) || !text(t.kind) || !text(t.id)) bad('identity.target must be exactly kind and id');
  }

  const tm = input.timing;
  if (!isObject(tm) || !exactKeys(tm, ['claimedAt', 'executionStartedAt', 'authorityJudgedAt'])) bad('timing has missing or unknown keys');
  else {
    if (!ts(tm.claimedAt) || !ts(tm.executionStartedAt) || !(tm.authorityJudgedAt === null || ts(tm.authorityJudgedAt))) bad('timing values must be millisecond UTC timestamps (authorityJudgedAt may be null)');
    else {
      if (Date.parse(tm.claimedAt as string) > Date.parse(tm.executionStartedAt as string)) bad('an execution cannot start before its claim');
      if (tm.authorityJudgedAt !== null && Date.parse(tm.authorityJudgedAt as string) < Date.parse(tm.executionStartedAt as string)) bad('authority cannot be judged before the execution started');
    }
  }

  const au = input.authority;
  let verdict: unknown;
  let authorityProven = false;
  if (!isObject(au) || !exactKeys(au, ['verdict', 'statusVerifiedAt', 'authorityVerifiedAt', 'statusAnswerDigest', 'provider'])) bad('authority has missing or unknown keys');
  else {
    verdict = au.verdict;
    authorityProven = au.statusVerifiedAt !== null && au.authorityVerifiedAt !== null && au.statusAnswerDigest !== null && au.provider !== null;
    if (!(EXECUTION_AUTHORITY_VERDICTS as readonly unknown[]).includes(au.verdict)) bad('authority.verdict is not a recognized verdict');
    if (!(au.statusVerifiedAt === null || ts(au.statusVerifiedAt)) || !(au.authorityVerifiedAt === null || ts(au.authorityVerifiedAt))) bad('authority verification times must be millisecond UTC or null');
    if (!(au.statusAnswerDigest === null || (typeof au.statusAnswerDigest === 'string' && DIGEST.test(au.statusAnswerDigest)))) bad('authority.statusAnswerDigest must be sha256:<64 hex> or null');
    if (!(au.provider === null || text(au.provider))) bad('authority.provider must be a name or null');
    if (au.verdict === 'NOT_CHECKED' && (au.statusVerifiedAt !== null || au.authorityVerifiedAt !== null)) bad('NOT_CHECKED authority cannot carry verification times');
  }

  const mu = input.mutation;
  let mutationResult: unknown;
  if (!isObject(mu) || !exactKeys(mu, ['result', 'balanceId', 'balanceVersionBefore', 'balanceVersionAfter', 'before', 'requested', 'after', 'baselineSource'])) bad('mutation has missing or unknown keys');
  else {
    mutationResult = mu.result;
    if (!(EXECUTION_MUTATION_RESULTS as readonly unknown[]).includes(mu.result)) bad('mutation.result must be APPLIED, NO_CHANGE or NOT_APPLICABLE');
    if (!(mu.balanceId === null || uuid(mu.balanceId))) bad('mutation.balanceId must be a UUID or null');
    for (const k of ['balanceVersionBefore', 'balanceVersionAfter'] as const) if (!(mu[k] === null || (typeof mu[k] === 'number' && Number.isSafeInteger(mu[k]) && (mu[k] as number) >= 0))) bad(`mutation.${k} must be a non-negative integer or null`);
    for (const k of ['before', 'requested', 'after'] as const) if (!(mu[k] === null || isObject(mu[k]))) bad(`mutation.${k} must be an object or null`);
    if (!(mu.baselineSource === null || mu.baselineSource === 'BO_EVALUATION_EVIDENCE')) bad('mutation.baselineSource is not recognized');
    if (mu.result === 'APPLIED') {
      if (mu.before === null || mu.requested === null || mu.after === null || mu.balanceId === null || mu.balanceVersionBefore === null || mu.balanceVersionAfter === null) bad('an APPLIED mutation records the balance, its before/requested/after state and versions');
      else if ((mu.balanceVersionAfter as number) !== (mu.balanceVersionBefore as number) + 1) bad('an APPLIED mutation advances the balance version by exactly one');
    }
    if (mu.result === 'NO_CHANGE' && (mu.before === null || mu.requested === null || mu.after !== null || mu.balanceVersionAfter !== null)) bad('a NO_CHANGE mutation records before/requested and no after-state');
    if (mu.result === 'NOT_APPLICABLE' && (mu.after !== null || mu.balanceVersionAfter !== null)) bad('a NOT_APPLICABLE mutation cannot carry an after-state');
  }

  if (!Array.isArray(input.preconditions) || !input.preconditions.every(isObject)) bad('preconditions must be an array of objects');
  const bd = input.boundaries;
  if (!isObject(bd) || !exactKeys(bd, ['executionWindow', 'budget', 'rollback', 'monitoring'])) bad('boundaries must be exactly executionWindow, budget, rollback, monitoring');

  const oc = input.outcome;
  if (!isObject(oc) || !exactKeys(oc, ['outcome', 'reasonCode', 'detail', 'attemptCount'])) bad('outcome has missing or unknown keys');
  else {
    if (!(EXECUTION_OUTCOMES as readonly unknown[]).includes(oc.outcome)) bad('outcome.outcome must be SUCCEEDED, REFUSED or FAILED');
    if (!(oc.reasonCode === null || text(oc.reasonCode))) bad('outcome.reasonCode must be a code or null');
    if (!(oc.detail === null || (typeof oc.detail === 'string' && oc.detail.length <= 1000))) bad('outcome.detail must be text (<= 1000) or null');
    if (!posInt(oc.attemptCount)) bad('outcome.attemptCount must be an integer >= 1');
    if (oc.outcome === 'SUCCEEDED') {
      if (oc.reasonCode !== null) bad('a SUCCEEDED execution has no reason code');
      if (mutationResult !== 'APPLIED' && mutationResult !== 'NO_CHANGE') bad('a SUCCEEDED execution is APPLIED or NO_CHANGE');
      if (verdict !== 'CURRENT') bad('a SUCCEEDED execution requires CURRENT authority');
      if (!authorityProven) bad('CURRENT authority requires its verification times, answer digest and provider');
    } else if (oc.outcome === 'REFUSED' || oc.outcome === 'FAILED') {
      if (oc.reasonCode === null) bad('a REFUSED or FAILED execution requires a reason code');
      if (mutationResult !== 'NOT_APPLICABLE') bad('a REFUSED or FAILED execution applied nothing (mutation.result NOT_APPLICABLE)');
    }
  }

  const ln = input.lineage;
  if (!isObject(ln) || !exactKeys(ln, ['correlationId', 'causationId', 'executor', 'authorization'])) bad('lineage has missing or unknown keys');
  else {
    if (!uuid(ln.correlationId)) bad('lineage.correlationId must be a UUID');
    if (!(ln.causationId === null || uuid(ln.causationId))) bad('lineage.causationId must be a UUID or null');
    const ex = ln.executor;
    if (!isObject(ex) || !exactKeys(ex, ['type', 'id']) || ex.type !== 'system' || !text(ex.id)) bad('lineage.executor must be a system executor');
    const az = ln.authorization;
    if (!isObject(az) || !exactKeys(az, ['actionId', 'decisionId', 'decisionVersionId', 'evaluationRefs'])) bad('lineage.authorization has missing or unknown keys');
    else {
      for (const k of ['actionId', 'decisionId', 'decisionVersionId'] as const) if (!(az[k] === null || uuid(az[k]))) bad(`lineage.authorization.${k} must be a UUID or null`);
      if (!Array.isArray(az.evaluationRefs)) bad('lineage.authorization.evaluationRefs must be an array');
    }
  }

  scanKeys(input, '$', p);
  try {
    if (JSON.stringify(input).length > MAX_EXECUTION_EVIDENCE_BYTES) bad('the evidence document is too large');
  } catch { bad('the evidence is not serializable'); }
  return p;
}

export interface ExecutionEvidenceValidation {
  valid: boolean;
  problems: string[];
}

/** Validates a SEALED document: the body, the integrity block, and that the digest equals the recomputed digest of the body. */
export function validateExecutionEvidence(input: unknown): ExecutionEvidenceValidation {
  if (!isObject(input)) return { valid: false, problems: ['the evidence must be an object'] };
  const { integrity, ...body } = input;
  const problems = validateExecutionEvidenceBody(body);
  if (!isObject(integrity) || !exactKeys(integrity, ['algorithm', 'canonicalVersion', 'digest'])) problems.push('integrity has missing or unknown keys');
  else {
    if (integrity.algorithm !== EXECUTION_EVIDENCE_DIGEST_ALGORITHM) problems.push('integrity.algorithm must be sha256');
    if (typeof integrity.canonicalVersion !== 'string' || !SUPPORTED_AAP_CANONICAL_VERSIONS.includes(integrity.canonicalVersion)) problems.push('integrity.canonicalVersion is not supported');
    if (typeof integrity.digest !== 'string' || !DIGEST.test(integrity.digest)) problems.push('integrity.digest must be sha256:<64 hex>');
    else if (problems.length === 0) {
      try {
        if (computeExecutionEvidenceDigest(body) !== integrity.digest) problems.push('the evidence does not match its digest (tampered or substituted)');
      } catch { problems.push('the evidence cannot be canonicalised'); }
    }
  }
  return { valid: problems.length === 0, problems };
}
