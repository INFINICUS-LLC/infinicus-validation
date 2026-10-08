// AuthorizedActionPackage v1 - validator, sealing and pre-execution evaluation (P0-5 Block 2).
//
// PURE: no database, no I/O, no clock. Time is always supplied by the caller (database time in production).
// Never trusts caller-supplied authority: it validates structure, governed applicability, action-type conformance,
// modification lineage, validity arithmetic and the integrity digest, and fails closed.
//
// Three entry points:
//  - validatePackageBody(body)           : an unsealed candidate (what the ABA issuer assembles).
//  - sealAuthorizedActionPackage(body)   : validate then attach the integrity block. The ONLY creation function; the
//                                          architecture test restricts its use to the issuer (owner ruling R-8).
//  - validateAuthorizedActionPackage(p)  : a sealed package (structure + digest).
//  - validateForExecution(p, ctx)        : what Business Operations runs immediately before execution (owner ruling R-10):
//                                          validation + scope + capability + window + AUTHORITATIVE status. Fails closed.

import { AAP_CONTRACT_VERSION, AAP_DIGEST_ALGORITHM, AUTOMATION_LEVELS, CURRENT_PACKAGE_ENABLEMENT, GOVERNANCE_DIMENSIONS, PACKAGE_LIFECYCLE_STATES, RISK_CLASSES, SUPPORTED_AAP_CANONICAL_VERSIONS, SUPPORTED_AAP_CONTRACT_VERSIONS } from './types';
import type {
  AccountableOwner, AuthoritativePackageStatus, AuthorizedActionPackageBody, AuthorizedActionPackageV1, ExpiryBound,
  ExpiryBoundSource, Governed, GovernanceDimension, GovernanceEvidence, JsonValue, Modification, ModificationEvaluation,
  NotApplicableReason, PackageAction, PackageAuthorization, PackageLineage, PackageScope, PackageValidity, ParameterChange,
  Precondition, PreconditionOperator, ProposedParameters, RiskClass, RiskClassBasis, PackageEnablementPolicy, AutomationLevelValue,
  HumanApprovalProvenance, RuleAuthorizedProvenance, RiskFacts,
} from './types';
import { buildIntegrity, canonicalize, CanonicalizationError, computePackageDigest, isWellFormedDigest } from './canonical';
import { isDecimalString, isDottedNumeric } from './primitives';
import { ACTION_APPLICABILITY_FIELDS, checkParameterValue, requiredGovernanceDimensions } from './action-types';
import type { ActionCapabilityRegistry, ActionTypeContract, ActionTypeRegistry } from './action-types';

// -------------------------------------------------------------------------------------------------------------------
// Error taxonomy
// -------------------------------------------------------------------------------------------------------------------

export const AAP_ERROR_CODES = [
  // structure
  'NOT_AN_OBJECT', 'MISSING_FIELD', 'UNKNOWN_FIELD', 'INVALID_TYPE', 'INVALID_FORMAT', 'INVALID_VALUE', 'FORBIDDEN_VALUE',
  // contract / versioning
  'UNSUPPORTED_CONTRACT_VERSION', 'UNSUPPORTED_CANONICAL_VERSION', 'UNSUPPORTED_DIGEST_ALGORITHM', 'UNSUPPORTED_CONSUMPTION_MODE',
  // governed applicability
  'REQUIRED_FIELD_UNAVAILABLE', 'NOT_APPLICABLE_NOT_PERMITTED',
  // action type
  'ACTION_TYPE_UNKNOWN', 'ACTION_TARGET_KIND_INVALID', 'ACTION_PARAMETER_UNKNOWN', 'ACTION_PARAMETER_MISSING', 'ACTION_PARAMETER_INVALID',
  'ACTION_TYPE_UNSUPPORTED_BY_EXECUTOR',
  // lineage / modification
  'MODIFICATION_REQUIRED', 'MODIFICATION_NOT_ALLOWED', 'MODIFICATION_LINEAGE_INCONSISTENT', 'MODIFICATION_EVALUATION_MISSING', 'MODIFICATION_EVALUATION_INVALID',
  // authorization
  'OWNER_INVALID', 'PROVENANCE_INVALID', 'AUTOMATION_LEVEL_NOT_PERMITTED', 'AUTOMATION_LEVEL_NOT_ENABLED', 'AUTHORIZATION_MODE_MISMATCH', 'RISK_INCONSISTENT',
  // validity
  'VALIDITY_INCONSISTENT', 'WINDOW_INVALID', 'EXPIRY_MISMATCH', 'TIMELINE_INCONSISTENT', 'ISSUED_IN_FUTURE', 'PACKAGE_EXPIRED',
  'EXECUTION_WINDOW_NOT_OPEN',
  // integrity
  'DIGEST_MALFORMED', 'DIGEST_MISMATCH',
  // pre-execution
  'CONTEXT_INVALID', 'SCOPE_MISMATCH', 'STATUS_UNVERIFIED', 'PACKAGE_REVOKED', 'PACKAGE_SUPERSEDED', 'PACKAGE_ALREADY_CONSUMED', 'PACKAGE_NOT_CURRENT_VERSION',
] as const;
export type AapErrorCode = (typeof AAP_ERROR_CODES)[number];

export interface AapValidationError {
  code: AapErrorCode;
  /** JSON-path style location, e.g. $.action.parameters.quantity. */
  path: string;
  message: string;
}

export interface AapValidationResult {
  valid: boolean;
  errors: readonly AapValidationError[];
}

export class AuthorizedActionPackageInvalidError extends Error {
  constructor(public readonly errors: readonly AapValidationError[]) {
    super(`AuthorizedActionPackage is invalid: ${errors.map((e) => `${e.code}@${e.path}`).join(', ')}`);
    this.name = 'AuthorizedActionPackageInvalidError';
  }
}

// -------------------------------------------------------------------------------------------------------------------
// Primitive checks
// -------------------------------------------------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const REASON_CODE = /^[A-Z][A-Z0-9_]*$/;
const PERMISSION = /^[a-z]+:[a-z_]+$/;
const CURRENCY = /^[A-Z]{3}$/;
const CODE = /^[a-z][a-z0-9_]*$/;
const MAX_TEXT = 2000;
const MAX_INSTRUCTIONS = 10000;
const MAX_COLLECTION = 500;
const MAX_CANONICAL_CHARS = 256 * 1024;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const CREDENTIAL_LIKE = ['password', 'secret', 'apikey', 'token', 'credential', 'privatekey'];
const OPERATORS: readonly PreconditionOperator[] = ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'between', 'in', 'not_in', 'contains'];

export function isValidTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !TIMESTAMP.test(value)) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

const toMs = (iso: string): number => Date.parse(iso);

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const isMarker = (v: unknown): boolean => isRec(v) && v.state === 'UNAVAILABLE';

/** Collects errors; an optional domain code re-labels purely structural errors inside owner / provenance blocks. */
class Collector {
  readonly errors: AapValidationError[] = [];
  private domain: AapErrorCode | null = null;
  private static readonly STRUCTURAL = new Set<AapErrorCode>(['MISSING_FIELD', 'UNKNOWN_FIELD', 'INVALID_TYPE', 'INVALID_FORMAT', 'INVALID_VALUE', 'NOT_AN_OBJECT']);

  add(code: AapErrorCode, path: string, message: string): void {
    if (this.domain !== null && Collector.STRUCTURAL.has(code)) {
      this.errors.push({ code: this.domain, path, message: `${code}: ${message}` });
      return;
    }
    this.errors.push({ code, path, message });
  }

  within<T>(domain: AapErrorCode, fn: () => T): T {
    const previous = this.domain;
    this.domain = domain;
    try { return fn(); } finally { this.domain = previous; }
  }

  get count(): number { return this.errors.length; }
}

// -------------------------------------------------------------------------------------------------------------------
// Structural readers. Each returns the typed value, or undefined after recording why (never throws).
// A node that is an UNAVAILABLE marker has already been reported by the global scan and is skipped silently.
// -------------------------------------------------------------------------------------------------------------------

function readObject(c: Collector, path: string, v: unknown, required: readonly string[], optional: readonly string[] = []): Rec | undefined {
  if (isMarker(v)) return undefined;
  if (!isRec(v)) { c.add('NOT_AN_OBJECT', path, 'must be an object'); return undefined; }
  let ok = true;
  for (const key of required) if (!(key in v)) { c.add('MISSING_FIELD', `${path}.${key}`, 'required field is missing'); ok = false; }
  for (const key of Object.keys(v)) {
    if (!required.includes(key) && !optional.includes(key)) { c.add('UNKNOWN_FIELD', `${path}.${key}`, 'field is not part of this contract version'); ok = false; }
  }
  return ok ? v : undefined;
}

function readString(c: Collector, path: string, v: unknown, max = MAX_TEXT): string | undefined {
  if (isMarker(v)) return undefined;
  if (typeof v !== 'string') { c.add('INVALID_TYPE', path, 'must be a string'); return undefined; }
  if (v.trim().length === 0 || v.length > max) { c.add('INVALID_VALUE', path, `must be a non-empty string of at most ${max} characters`); return undefined; }
  return v;
}

function readUuid(c: Collector, path: string, v: unknown): string | undefined {
  if (isMarker(v)) return undefined;
  if (typeof v !== 'string') { c.add('INVALID_TYPE', path, 'must be a string'); return undefined; }
  if (!UUID.test(v)) { c.add('INVALID_FORMAT', path, 'must be a lowercase canonical UUID'); return undefined; }
  return v;
}

function readTimestamp(c: Collector, path: string, v: unknown): string | undefined {
  if (isMarker(v)) return undefined;
  if (typeof v !== 'string') { c.add('INVALID_TYPE', path, 'must be a string'); return undefined; }
  if (!isValidTimestamp(v)) { c.add('INVALID_FORMAT', path, 'must be a UTC timestamp in YYYY-MM-DDTHH:mm:ss.sssZ form'); return undefined; }
  return v;
}

function readInt(c: Collector, path: string, v: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number | undefined {
  if (isMarker(v)) return undefined;
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) { c.add('INVALID_TYPE', path, 'must be a safe integer'); return undefined; }
  if (v < min || v > max) { c.add('INVALID_VALUE', path, `must be between ${min} and ${max}`); return undefined; }
  return v;
}

function readBool(c: Collector, path: string, v: unknown): boolean | undefined {
  if (isMarker(v)) return undefined;
  if (typeof v !== 'boolean') { c.add('INVALID_TYPE', path, 'must be a boolean'); return undefined; }
  return v;
}

function readPattern(c: Collector, path: string, v: unknown, pattern: RegExp | ((s: string) => boolean), what: string): string | undefined {
  const s = readString(c, path, v);
  if (s === undefined) return undefined;
  const ok = typeof pattern === 'function' ? pattern(s) : pattern.test(s);
  if (!ok) { c.add('INVALID_FORMAT', path, `must be ${what}`); return undefined; }
  return s;
}

function readEnum<T extends string>(c: Collector, path: string, v: unknown, values: readonly T[]): T | undefined {
  if (isMarker(v)) return undefined;
  if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) { c.add('INVALID_VALUE', path, `must be one of: ${values.join(', ')}`); return undefined; }
  return v as T;
}

function readArray<T>(c: Collector, path: string, v: unknown, readItem: (p: string, item: unknown) => T | undefined, minLength = 0): T[] | undefined {
  if (isMarker(v)) return undefined;
  if (!Array.isArray(v)) { c.add('INVALID_TYPE', path, 'must be an array'); return undefined; }
  if (v.length < minLength || v.length > MAX_COLLECTION) { c.add('INVALID_VALUE', path, `must hold between ${minLength} and ${MAX_COLLECTION} entries`); return undefined; }
  const out: T[] = [];
  let ok = true;
  v.forEach((item, i) => {
    const r = readItem(`${path}[${i}]`, item);
    if (r === undefined) ok = false; else out.push(r);
  });
  return ok ? out : undefined;
}

function readNotApplicableReason(c: Collector, path: string, v: unknown): NotApplicableReason | undefined {
  const o = readObject(c, path, v, ['code', 'statement'], ['basis']);
  if (!o) return undefined;
  const code = readPattern(c, `${path}.code`, o.code, REASON_CODE, 'an UPPER_SNAKE reason code');
  const statement = readString(c, `${path}.statement`, o.statement);
  if (code === undefined || statement === undefined) return undefined;
  if (!('basis' in o)) return { code, statement };
  const b = readObject(c, `${path}.basis`, o.basis, ['kind', 'ref']);
  const kind = b ? readEnum(c, `${path}.basis.kind`, b.kind, ['ACTION_SCHEMA', 'POLICY'] as const) : undefined;
  const ref = b ? readString(c, `${path}.basis.ref`, b.ref, 200) : undefined;
  return kind !== undefined && ref !== undefined ? { code, statement, basis: { kind, ref } } : undefined;
}

/** A governed field: {state:'VALUE',value} or {state:'NOT_APPLICABLE',reason}. Any other state is rejected. */
function readGoverned<T>(c: Collector, path: string, v: unknown, readValue: (p: string, x: unknown) => T | undefined): Governed<T> | undefined {
  if (isMarker(v)) return undefined;
  if (!isRec(v)) { c.add('NOT_AN_OBJECT', path, 'must be a governed field object'); return undefined; }
  if (v.state === 'VALUE') {
    const o = readObject(c, path, v, ['state', 'value']);
    if (!o) return undefined;
    const value = readValue(`${path}.value`, o.value);
    return value === undefined ? undefined : { state: 'VALUE', value };
  }
  if (v.state === 'NOT_APPLICABLE') {
    const o = readObject(c, path, v, ['state', 'reason']);
    if (!o) return undefined;
    const reason = readNotApplicableReason(c, `${path}.reason`, o.reason);
    return reason === undefined ? undefined : { state: 'NOT_APPLICABLE', reason };
  }
  c.add('INVALID_VALUE', `${path}.state`, 'must be VALUE or NOT_APPLICABLE (an UNAVAILABLE field can never be issued)');
  return undefined;
}

function readJson(c: Collector, path: string, v: unknown): JsonValue | undefined {
  if (isMarker(v)) return undefined;
  // The whole input was already proven to be in the canonical JSON domain; this narrows the type only.
  if (v === undefined) { c.add('INVALID_TYPE', path, 'value is required'); return undefined; }
  return v as JsonValue;
}

function readParameterMap(c: Collector, path: string, v: unknown): Record<string, JsonValue> | undefined {
  if (isMarker(v)) return undefined;
  if (!isRec(v)) { c.add('NOT_AN_OBJECT', path, 'must be an object'); return undefined; }
  if (Object.keys(v).length === 0) { c.add('INVALID_VALUE', path, 'must hold at least one parameter'); return undefined; }
  return v as Record<string, JsonValue>;
}

// -------------------------------------------------------------------------------------------------------------------
// Global scans over the raw input
// -------------------------------------------------------------------------------------------------------------------

function scanUnavailable(c: Collector, value: unknown, path: string): void {
  if (Array.isArray(value)) { value.forEach((x, i) => scanUnavailable(c, x, `${path}[${i}]`)); return; }
  if (!isRec(value)) return;
  if (value.state === 'UNAVAILABLE') {
    c.add('REQUIRED_FIELD_UNAVAILABLE', path, `required source is unavailable${typeof value.source === 'string' ? ` (${value.source})` : ''}; an issued package may not contain it`);
    return;
  }
  for (const [k, child] of Object.entries(value)) scanUnavailable(c, child, `${path}.${k}`);
}

function scanForbiddenKeys(c: Collector, value: unknown, path: string): void {
  if (Array.isArray(value)) { value.forEach((x, i) => scanForbiddenKeys(c, x, `${path}[${i}]`)); return; }
  if (!isRec(value)) return;
  for (const [k, child] of Object.entries(value)) {
    if (DANGEROUS_KEYS.has(k)) { c.add('FORBIDDEN_VALUE', `${path}.${k}`, 'dangerous key'); continue; }
    if (CREDENTIAL_LIKE.some((frag) => k.toLowerCase().includes(frag))) { c.add('FORBIDDEN_VALUE', `${path}.${k}`, 'credential-like key'); continue; }
    scanForbiddenKeys(c, child, `${path}.${k}`);
  }
}

// -------------------------------------------------------------------------------------------------------------------
// Parsing (structure) - produces a typed body or undefined
// -------------------------------------------------------------------------------------------------------------------

function parseBody(c: Collector, root: Rec): AuthorizedActionPackageBody | undefined {
  const before = c.count;
  const top = readObject(c, '$', root, ['contractVersion', 'identity', 'scope', 'issuance', 'action', 'lineage', 'authorization', 'accountableOwner', 'validity', 'consumption', 'trace']);
  if (!top) return undefined;

  const identity = (() => {
    const o = readObject(c, '$.identity', top.identity, ['packageId', 'packageVersion', 'supersedes']);
    if (!o) return undefined;
    const packageId = readUuid(c, '$.identity.packageId', o.packageId);
    const packageVersion = readInt(c, '$.identity.packageVersion', o.packageVersion, 1);
    let supersedes: { packageId: string; packageVersion: number } | null | undefined;
    if (o.supersedes === null) supersedes = null;
    else {
      const s = readObject(c, '$.identity.supersedes', o.supersedes, ['packageId', 'packageVersion']);
      const sid = s ? readUuid(c, '$.identity.supersedes.packageId', s.packageId) : undefined;
      const sv = s ? readInt(c, '$.identity.supersedes.packageVersion', s.packageVersion, 1) : undefined;
      supersedes = sid !== undefined && sv !== undefined ? { packageId: sid, packageVersion: sv } : undefined;
    }
    return packageId !== undefined && packageVersion !== undefined && supersedes !== undefined ? { packageId, packageVersion, supersedes } : undefined;
  })();

  const scope = (() => {
    const o = readObject(c, '$.scope', top.scope, ['tenantId', 'workspaceId', 'businessId']);
    if (!o) return undefined;
    const tenantId = readUuid(c, '$.scope.tenantId', o.tenantId);
    const workspaceId = readUuid(c, '$.scope.workspaceId', o.workspaceId);
    const businessId = readUuid(c, '$.scope.businessId', o.businessId);
    return tenantId && workspaceId && businessId ? { tenantId, workspaceId, businessId } : undefined;
  })();

  const issuance = (() => {
    const o = readObject(c, '$.issuance', top.issuance, ['issuedAt', 'issuerComponent']);
    if (!o) return undefined;
    const issuedAt = readTimestamp(c, '$.issuance.issuedAt', o.issuedAt);
    const issuerComponent = readString(c, '$.issuance.issuerComponent', o.issuerComponent, 200);
    return issuedAt && issuerComponent ? { issuedAt, issuerComponent } : undefined;
  })();

  const action = parseAction(c, top.action);
  const lineage = parseLineage(c, top.lineage);
  const authorization = c.within('PROVENANCE_INVALID', () => parseAuthorization(c, top.authorization));
  const accountableOwner = c.within('OWNER_INVALID', () => parseOwner(c, top.accountableOwner));
  const validity = parseValidity(c, top.validity);

  const consumption = (() => {
    if (isMarker(top.consumption)) return undefined;
    const o = readObject(c, '$.consumption', top.consumption, ['mode']);
    if (!o) return undefined;
    if (o.mode !== 'SINGLE_USE') { c.add('UNSUPPORTED_CONSUMPTION_MODE', '$.consumption.mode', 'aap/1 packages are single-use'); return undefined; }
    return { mode: 'SINGLE_USE' as const };
  })();

  const trace = c.within('PROVENANCE_INVALID', () => {
    const o = readObject(c, '$.trace', top.trace, ['correlationId', 'causationId']);
    if (!o) return undefined;
    const correlationId = readString(c, '$.trace.correlationId', o.correlationId, 200);
    const causationId = readUuid(c, '$.trace.causationId', o.causationId);
    return correlationId && causationId ? { correlationId, causationId } : undefined;
  });

  if (c.count !== before || !identity || !scope || !issuance || !action || !lineage || !authorization || !accountableOwner || !validity || !consumption || !trace) return undefined;
  return { contractVersion: AAP_CONTRACT_VERSION, identity, scope, issuance, action, lineage, authorization, accountableOwner, validity, consumption, trace };
}

function parseAction(c: Collector, v: unknown): PackageAction | undefined {
  const o = readObject(c, '$.action', v, ['actionId', 'actionVersionId', 'type', 'target', 'parameters', 'automationLevel', 'executionWindow', 'preconditions', 'budget', 'rollback', 'monitoring']);
  if (!o) return undefined;
  const actionId = readUuid(c, '$.action.actionId', o.actionId);
  const actionVersionId = readUuid(c, '$.action.actionVersionId', o.actionVersionId);

  const typeObj = readObject(c, '$.action.type', o.type, ['code', 'schemaVersion']);
  const typeCode = typeObj ? readPattern(c, '$.action.type.code', typeObj.code, CODE, 'a lowercase snake_case action-type code') : undefined;
  const typeVersion = typeObj ? readPattern(c, '$.action.type.schemaVersion', typeObj.schemaVersion, isDottedNumeric, 'a dotted numeric schema version') : undefined;

  const targetObj = readObject(c, '$.action.target', o.target, ['kind', 'id']);
  const targetKind = targetObj ? readPattern(c, '$.action.target.kind', targetObj.kind, CODE, 'a lowercase snake_case target kind') : undefined;
  const targetId = targetObj ? readString(c, '$.action.target.id', targetObj.id, 200) : undefined;

  const parameters = readParameterMap(c, '$.action.parameters', o.parameters);

  const levelObj = readObject(c, '$.action.automationLevel', o.automationLevel, ['level', 'policy']);
  const level = levelObj ? readInt(c, '$.action.automationLevel.level', levelObj.level, 0, 4) : undefined;
  const policyObj = levelObj ? readObject(c, '$.action.automationLevel.policy', levelObj.policy, ['policyId', 'policyVersionId']) : undefined;
  const policyId = policyObj ? readUuid(c, '$.action.automationLevel.policy.policyId', policyObj.policyId) : undefined;
  const policyVersionId = policyObj ? readUuid(c, '$.action.automationLevel.policy.policyVersionId', policyObj.policyVersionId) : undefined;

  const executionWindow = readGoverned(c, '$.action.executionWindow', o.executionWindow, (p, x) => {
    const w = readObject(c, p, x, ['startsAt', 'endsAt']);
    if (!w) return undefined;
    const startsAt = readTimestamp(c, `${p}.startsAt`, w.startsAt);
    const endsAt = w.endsAt === null ? null : readTimestamp(c, `${p}.endsAt`, w.endsAt);
    return startsAt !== undefined && endsAt !== undefined ? { startsAt, endsAt } : undefined;
  });

  const preconditions = readGoverned<readonly Precondition[]>(c, '$.action.preconditions', o.preconditions, (p, x) =>
    readArray<Precondition>(c, p, x, (ip, item) => {
      const pc = readObject(c, ip, item, ['code', 'operator', 'operand']);
      if (!pc) return undefined;
      const code = readString(c, `${ip}.code`, pc.code, 200);
      const operator = readEnum<PreconditionOperator>(c, `${ip}.operator`, pc.operator, OPERATORS);
      const operand = readJson(c, `${ip}.operand`, pc.operand);
      return code !== undefined && operator !== undefined && operand !== undefined ? { code, operator, operand } : undefined;
    }, 1));

  const budget = readGoverned(c, '$.action.budget', o.budget, (p, x) => {
    const b = readObject(c, p, x, ['amount', 'currency']);
    if (!b) return undefined;
    const amount = readPattern(c, `${p}.amount`, b.amount, isDecimalString, 'a non-negative decimal string');
    const currency = readPattern(c, `${p}.currency`, b.currency, CURRENCY, 'an ISO 4217 currency code');
    return amount !== undefined && currency !== undefined ? { amount, currency } : undefined;
  });

  const rollback = readGoverned(c, '$.action.rollback', o.rollback, (p, x) => {
    const r = readObject(c, p, x, ['instructions']);
    const instructions = r ? readString(c, `${p}.instructions`, r.instructions, MAX_INSTRUCTIONS) : undefined;
    return instructions !== undefined ? { instructions } : undefined;
  });

  const monitoring = readGoverned(c, '$.action.monitoring', o.monitoring, (p, x) => {
    const m = readObject(c, p, x, ['metrics']);
    if (!m) return undefined;
    const metrics = readArray(c, `${p}.metrics`, m.metrics, (ip, item) => {
      const mo = readObject(c, ip, item, ['metricCode', 'target', 'unit']);
      if (!mo) return undefined;
      const metricCode = readString(c, `${ip}.metricCode`, mo.metricCode, 200);
      const target = mo.target === null ? null : readJson(c, `${ip}.target`, mo.target);
      const unit = mo.unit === null ? null : readString(c, `${ip}.unit`, mo.unit, 50);
      return metricCode !== undefined && target !== undefined && unit !== undefined ? { metricCode, target, unit } : undefined;
    }, 1);
    return metrics !== undefined ? { metrics } : undefined;
  });

  if (!actionId || !actionVersionId || !typeCode || !typeVersion || !targetKind || !targetId || !parameters || level === undefined || !policyId || !policyVersionId || !executionWindow || !preconditions || !budget || !rollback || !monitoring) return undefined;
  return {
    actionId, actionVersionId,
    type: { code: typeCode, schemaVersion: typeVersion },
    target: { kind: targetKind, id: targetId },
    parameters,
    // 0-1 are rejected semantically (AUTOMATION_LEVEL_NOT_PERMITTED) and enablement is policy (AUTOMATION_LEVEL_NOT_ENABLED); the cast keeps the typed shape.
    automationLevel: { level: level as AutomationLevelValue, policy: { policyId, policyVersionId } },
    executionWindow, preconditions, budget, rollback, monitoring,
  };
}

function parseLineage(c: Collector, v: unknown): PackageLineage | undefined {
  const o = readObject(c, '$.lineage', v, ['recommendation', 'review', 'decision', 'twinSnapshotId', 'simulationRunId', 'proposedParameters', 'modification', 'modificationEvaluation']);
  if (!o) return undefined;

  const rec = readObject(c, '$.lineage.recommendation', o.recommendation, ['recommendationId', 'recommendationVersionId']);
  const recommendationId = rec ? readUuid(c, '$.lineage.recommendation.recommendationId', rec.recommendationId) : undefined;
  const recommendationVersionId = rec ? readUuid(c, '$.lineage.recommendation.recommendationVersionId', rec.recommendationVersionId) : undefined;

  const rev = readObject(c, '$.lineage.review', o.review, ['reviewPackageId', 'reviewVersionId']);
  const reviewPackageId = rev ? readUuid(c, '$.lineage.review.reviewPackageId', rev.reviewPackageId) : undefined;
  const reviewVersionId = rev ? readUuid(c, '$.lineage.review.reviewVersionId', rev.reviewVersionId) : undefined;

  const dec = readObject(c, '$.lineage.decision', o.decision, ['decisionId', 'decisionVersionId']);
  const decisionId = dec ? readUuid(c, '$.lineage.decision.decisionId', dec.decisionId) : undefined;
  const decisionVersionId = dec ? readUuid(c, '$.lineage.decision.decisionVersionId', dec.decisionVersionId) : undefined;

  const twinSnapshotId = readGoverned(c, '$.lineage.twinSnapshotId', o.twinSnapshotId, (p, x) => readUuid(c, p, x));
  const simulationRunId = readGoverned(c, '$.lineage.simulationRunId', o.simulationRunId, (p, x) => readUuid(c, p, x));

  const proposedParameters = readGoverned<ProposedParameters>(c, '$.lineage.proposedParameters', o.proposedParameters, (p, x) => {
    const pp = readObject(c, p, x, ['source', 'parameters']);
    if (!pp) return undefined;
    const src = readObject(c, `${p}.source`, pp.source, ['layer', 'recordType', 'recordId']);
    const layer = src ? readEnum(c, `${p}.source.layer`, src.layer, ['ADI'] as const) : undefined;
    const recordType = src ? readString(c, `${p}.source.recordType`, src.recordType, 200) : undefined;
    const recordId = src ? readUuid(c, `${p}.source.recordId`, src.recordId) : undefined;
    const parameters = readParameterMap(c, `${p}.parameters`, pp.parameters);
    return layer && recordType && recordId && parameters ? { source: { layer, recordType, recordId }, parameters } : undefined;
  });

  const modification = readGoverned<Modification>(c, '$.lineage.modification', o.modification, (p, x) => {
    const m = readObject(c, p, x, ['reason', 'modifiedByUserId', 'modifiedAt', 'changes']);
    if (!m) return undefined;
    const reason = readString(c, `${p}.reason`, m.reason);
    const modifiedByUserId = readUuid(c, `${p}.modifiedByUserId`, m.modifiedByUserId);
    const modifiedAt = readTimestamp(c, `${p}.modifiedAt`, m.modifiedAt);
    const changes = readArray<ParameterChange>(c, `${p}.changes`, m.changes, (ip, item) => {
      const ch = readObject(c, ip, item, ['parameter', 'operation'], ['before', 'after']);
      if (!ch) return undefined;
      const parameter = readString(c, `${ip}.parameter`, ch.parameter, 200);
      const operation = readEnum(c, `${ip}.operation`, ch.operation, ['SET', 'ADD', 'REMOVE'] as const);
      if (parameter === undefined || operation === undefined) return undefined;
      const out: ParameterChange = { parameter, operation };
      if ('before' in ch) { const b = readJson(c, `${ip}.before`, ch.before); if (b === undefined) return undefined; out.before = b; }
      if ('after' in ch) { const a = readJson(c, `${ip}.after`, ch.after); if (a === undefined) return undefined; out.after = a; }
      return out;
    }, 1);
    return reason !== undefined && modifiedByUserId !== undefined && modifiedAt !== undefined && changes !== undefined ? { reason, modifiedByUserId, modifiedAt, changes } : undefined;
  });

  const modificationEvaluation = readGoverned<ModificationEvaluation>(c, '$.lineage.modificationEvaluation', o.modificationEvaluation, (p, x) => {
    const e = readObject(c, p, x, ['basis', 'evidence']);
    if (!e) return undefined;
    const basis = readEnum(c, `${p}.basis`, e.basis, ['DECLARED_IMPACT', 'CONSERVATIVE_FULL'] as const);
    const evidence = readArray<GovernanceEvidence>(c, `${p}.evidence`, e.evidence, (ip, item) => {
      const ev = readObject(c, ip, item, ['dimension', 'evaluatedAt', 'result', 'evidenceRef']);
      if (!ev) return undefined;
      const dimension = readEnum<GovernanceDimension>(c, `${ip}.dimension`, ev.dimension, GOVERNANCE_DIMENSIONS);
      const evaluatedAt = readTimestamp(c, `${ip}.evaluatedAt`, ev.evaluatedAt);
      const result = readEnum(c, `${ip}.result`, ev.result, ['PASSED'] as const);
      const ref = readObject(c, `${ip}.evidenceRef`, ev.evidenceRef, ['kind', 'id']);
      const kind = ref ? readString(c, `${ip}.evidenceRef.kind`, ref.kind, 200) : undefined;
      const id = ref ? readString(c, `${ip}.evidenceRef.id`, ref.id, 200) : undefined;
      return dimension && evaluatedAt && result && kind && id ? { dimension, evaluatedAt, result, evidenceRef: { kind, id } } : undefined;
    }, 1);
    return basis !== undefined && evidence !== undefined ? { basis, evidence } : undefined;
  });

  if (!recommendationId || !recommendationVersionId || !reviewPackageId || !reviewVersionId || !decisionId || !decisionVersionId || !twinSnapshotId || !simulationRunId || !proposedParameters || !modification || !modificationEvaluation) return undefined;
  return {
    recommendation: { recommendationId, recommendationVersionId },
    review: { reviewPackageId, reviewVersionId },
    decision: { decisionId, decisionVersionId },
    twinSnapshotId, simulationRunId, proposedParameters, modification, modificationEvaluation,
  };
}

function readRisk(c: Collector, path: string, o: Rec | undefined): RiskFacts | undefined {
  if (!o) return undefined;
  const riskClass = readEnum<RiskClass>(c, `${path}.riskClass`, o.riskClass, RISK_CLASSES);
  const basis = readEnum<RiskClassBasis>(c, `${path}.basis`, o.basis, ['PERSISTED', 'UNCLASSIFIED_FAIL_CLOSED_HIGH']);
  return riskClass !== undefined && basis !== undefined ? { riskClass, basis } : undefined;
}

/** Authorization provenance is a discriminated union on `mode`; each mode has its own strict field set. */
function parseAuthorization(c: Collector, v: unknown): PackageAuthorization | undefined {
  if (isMarker(v)) return undefined;
  if (!isRec(v)) { c.add('NOT_AN_OBJECT', '$.authorization', 'must be an object'); return undefined; }
  if (v.mode === 'HUMAN_APPROVAL') return parseHumanApproval(c, v);
  if (v.mode === 'RULE_AUTHORIZED') return parseRuleAuthorized(c, v);
  c.add('INVALID_VALUE', '$.authorization.mode', 'must be HUMAN_APPROVAL or RULE_AUTHORIZED');
  return undefined;
}

function parseHumanApproval(c: Collector, v: Rec): HumanApprovalProvenance | undefined {
  const o = readObject(c, '$.authorization', v, ['mode', 'decisionStatus', 'decidedAt', 'approver', 'authorityProvenance', 'permissionUsed', 'approvalAuditEventId', 'risk']);
  if (!o) return undefined;
  const decisionStatus = readEnum(c, '$.authorization.decisionStatus', o.decisionStatus, ['approved', 'approved_with_modifications'] as const);
  const decidedAt = readTimestamp(c, '$.authorization.decidedAt', o.decidedAt);

  const ap = readObject(c, '$.authorization.approver', o.approver, ['userId', 'assignmentId', 'assignmentVersionId', 'roleCode']);
  const userId = ap ? readUuid(c, '$.authorization.approver.userId', ap.userId) : undefined;
  const assignmentId = ap ? readUuid(c, '$.authorization.approver.assignmentId', ap.assignmentId) : undefined;
  const assignmentVersionId = ap ? readUuid(c, '$.authorization.approver.assignmentVersionId', ap.assignmentVersionId) : undefined;
  const roleCode = ap ? readString(c, '$.authorization.approver.roleCode', ap.roleCode, 100) : undefined;

  const prov = readObject(c, '$.authorization.authorityProvenance', o.authorityProvenance, ['scopeId']);
  const scopeId = prov ? readUuid(c, '$.authorization.authorityProvenance.scopeId', prov.scopeId) : undefined;

  const permissionUsed = readPattern(c, '$.authorization.permissionUsed', o.permissionUsed, PERMISSION, 'a permission code such as aba:write');
  const approvalAuditEventId = readUuid(c, '$.authorization.approvalAuditEventId', o.approvalAuditEventId);

  const risk = readObject(c, '$.authorization.risk', o.risk, ['riskClass', 'basis', 'requiredApproverTier', 'approverTier']);
  const facts = readRisk(c, '$.authorization.risk', risk);
  const requiredApproverTier = risk ? readInt(c, '$.authorization.risk.requiredApproverTier', risk.requiredApproverTier, 1, 10) : undefined;
  const approverTier = risk ? readInt(c, '$.authorization.risk.approverTier', risk.approverTier, 1, 10) : undefined;

  if (!decisionStatus || !decidedAt || !userId || !assignmentId || !assignmentVersionId || !roleCode || !scopeId || !permissionUsed || !approvalAuditEventId || !facts || requiredApproverTier === undefined || approverTier === undefined) return undefined;
  return {
    mode: 'HUMAN_APPROVAL', decisionStatus, decidedAt,
    approver: { userId, assignmentId, assignmentVersionId, roleCode },
    authorityProvenance: { scopeId },
    permissionUsed, approvalAuditEventId,
    risk: { ...facts, requiredApproverTier, approverTier },
  };
}

function parseRuleAuthorized(c: Collector, v: Rec): RuleAuthorizedProvenance | undefined {
  const o = readObject(c, '$.authorization', v, ['mode', 'policy', 'rule', 'evaluatedAt', 'servicePrincipal', 'governanceAuditEventId', 'risk']);
  if (!o) return undefined;
  const pol = readObject(c, '$.authorization.policy', o.policy, ['policyId', 'policyVersionId']);
  const policyId = pol ? readUuid(c, '$.authorization.policy.policyId', pol.policyId) : undefined;
  const policyVersionId = pol ? readUuid(c, '$.authorization.policy.policyVersionId', pol.policyVersionId) : undefined;
  const rule = readGoverned(c, '$.authorization.rule', o.rule, (p, x) => {
    const r = readObject(c, p, x, ['ruleId', 'ruleVersionId']);
    const ruleId = r ? readUuid(c, `${p}.ruleId`, r.ruleId) : undefined;
    const ruleVersionId = r ? readUuid(c, `${p}.ruleVersionId`, r.ruleVersionId) : undefined;
    return ruleId !== undefined && ruleVersionId !== undefined ? { ruleId, ruleVersionId } : undefined;
  });
  const evaluatedAt = readTimestamp(c, '$.authorization.evaluatedAt', o.evaluatedAt);
  const servicePrincipal = readGoverned(c, '$.authorization.servicePrincipal', o.servicePrincipal, (p, x) => {
    const sp = readObject(c, p, x, ['principalId', 'component']);
    const principalId = sp ? readString(c, `${p}.principalId`, sp.principalId, 200) : undefined;
    const component = sp ? readString(c, `${p}.component`, sp.component, 200) : undefined;
    return principalId !== undefined && component !== undefined ? { principalId, component } : undefined;
  });
  const governanceAuditEventId = readUuid(c, '$.authorization.governanceAuditEventId', o.governanceAuditEventId);
  const risk = readRisk(c, '$.authorization.risk', readObject(c, '$.authorization.risk', o.risk, ['riskClass', 'basis']));
  if (!policyId || !policyVersionId || !rule || !evaluatedAt || !servicePrincipal || !governanceAuditEventId || !risk) return undefined;
  return { mode: 'RULE_AUTHORIZED', policy: { policyId, policyVersionId }, rule, evaluatedAt, servicePrincipal, governanceAuditEventId, risk };
}

function parseOwner(c: Collector, v: unknown): AccountableOwner | undefined {
  const o = readObject(c, '$.accountableOwner', v, ['identity', 'roleCode', 'assignment', 'dueAt', 'escalationPolicy']);
  if (!o) return undefined;
  const id = readObject(c, '$.accountableOwner.identity', o.identity, ['userId', 'membershipId']);
  const userId = id ? readUuid(c, '$.accountableOwner.identity.userId', id.userId) : undefined;
  const membershipId = id ? readUuid(c, '$.accountableOwner.identity.membershipId', id.membershipId) : undefined;
  const roleCode = readString(c, '$.accountableOwner.roleCode', o.roleCode, 100);
  const asg = readObject(c, '$.accountableOwner.assignment', o.assignment, ['assignmentId', 'assignedByUserId', 'assignedAt']);
  const assignmentId = asg ? readUuid(c, '$.accountableOwner.assignment.assignmentId', asg.assignmentId) : undefined;
  const assignedByUserId = asg ? readUuid(c, '$.accountableOwner.assignment.assignedByUserId', asg.assignedByUserId) : undefined;
  const assignedAt = asg ? readTimestamp(c, '$.accountableOwner.assignment.assignedAt', asg.assignedAt) : undefined;
  const dueAt = readGoverned(c, '$.accountableOwner.dueAt', o.dueAt, (p, x) => readTimestamp(c, p, x));
  const escalationPolicy = readGoverned(c, '$.accountableOwner.escalationPolicy', o.escalationPolicy, (p, x) => {
    const e = readObject(c, p, x, ['ref']);
    const ref = e ? readString(c, `${p}.ref`, e.ref, 200) : undefined;
    return ref !== undefined ? { ref } : undefined;
  });
  if (!userId || !membershipId || !roleCode || !assignmentId || !assignedByUserId || !assignedAt || !dueAt || !escalationPolicy) return undefined;
  return { identity: { userId, membershipId }, roleCode, assignment: { assignmentId, assignedByUserId, assignedAt }, dueAt, escalationPolicy };
}

function parseValidity(c: Collector, v: unknown): PackageValidity | undefined {
  const o = readObject(c, '$.validity', v, ['isTimeSensitive', 'decisionValidUntil', 'freshness', 'expiryBounds', 'expiresAt']);
  if (!o) return undefined;
  const isTimeSensitive = readBool(c, '$.validity.isTimeSensitive', o.isTimeSensitive);
  const decisionValidUntil = readGoverned(c, '$.validity.decisionValidUntil', o.decisionValidUntil, (p, x) => readTimestamp(c, p, x));
  const fr = readObject(c, '$.validity.freshness', o.freshness, ['assessedAt', 'twin']);
  const assessedAt = fr ? readTimestamp(c, '$.validity.freshness.assessedAt', fr.assessedAt) : undefined;
  const twin = fr ? readEnum(c, '$.validity.freshness.twin', fr.twin, ['FRESH', 'NOT_APPLICABLE'] as const) : undefined;
  const expiryBounds = readArray<ExpiryBound>(c, '$.validity.expiryBounds', o.expiryBounds, (p, item) => {
    const b = readObject(c, p, item, ['source', 'at']);
    if (!b) return undefined;
    const source = readEnum<ExpiryBoundSource>(c, `${p}.source`, b.source, ['DECISION_VALID_UNTIL', 'EXECUTION_WINDOW_END', 'EXPLICIT_PACKAGE_EXPIRY']);
    const at = readTimestamp(c, `${p}.at`, b.at);
    return source && at ? { source, at } : undefined;
  });
  const expiresAt = readGoverned(c, '$.validity.expiresAt', o.expiresAt, (p, x) => readTimestamp(c, p, x));
  if (isTimeSensitive === undefined || !decisionValidUntil || !assessedAt || !twin || !expiryBounds || !expiresAt) return undefined;
  return { isTimeSensitive, decisionValidUntil, freshness: { assessedAt, twin }, expiryBounds, expiresAt };
}

// -------------------------------------------------------------------------------------------------------------------
// Expiry arithmetic (owner ruling R-6)
// -------------------------------------------------------------------------------------------------------------------

/** The earliest applicable bound (R-6), or null when no bound applies. */
export function computePackageExpiry(bounds: readonly ExpiryBound[]): string | null {
  let earliest: string | null = null;
  for (const b of bounds) if (earliest === null || toMs(b.at) < toMs(earliest)) earliest = b.at;
  return earliest;
}

// -------------------------------------------------------------------------------------------------------------------
// Semantic validation of a structurally valid body
// -------------------------------------------------------------------------------------------------------------------

const canonicalEqual = (a: unknown, b: unknown): boolean => canonicalize(a) === canonicalize(b);

function checkSemantics(c: Collector, body: AuthorizedActionPackageBody, actionTypes: ActionTypeRegistry, now: string | undefined, enablement: PackageEnablementPolicy): void {
  const { action, lineage, authorization, accountableOwner, validity, issuance } = body;
  const issuedMs = toMs(issuance.issuedAt);

  // --- action type conformance (R-1) ---
  const contract = actionTypes.resolve(action.type.code, action.type.schemaVersion);
  if (!contract) {
    c.add('ACTION_TYPE_UNKNOWN', '$.action.type', `no action-type contract for ${action.type.code}@${action.type.schemaVersion}`);
  } else {
    checkActionConformance(c, body, contract);
  }

  // --- automation level (R-3; ABA 17) and authorization mode ---
  // The contract recognizes Levels 2-4; 0-1 do not authorize execution. Which recognized levels are ENABLED is policy.
  const level = action.automationLevel.level;
  if (!(AUTOMATION_LEVELS as readonly number[]).includes(level)) {
    c.add('AUTOMATION_LEVEL_NOT_PERMITTED', '$.action.automationLevel.level', 'Levels 0 (observe) and 1 (recommend) do not authorize execution and are invalid for an AuthorizedActionPackage');
  } else {
    const expectedMode = level === 2 ? 'HUMAN_APPROVAL' : 'RULE_AUTHORIZED';
    if (authorization.mode !== expectedMode) {
      c.add('AUTHORIZATION_MODE_MISMATCH', '$.authorization.mode', `automation Level ${level} requires ${expectedMode} provenance; a ${authorization.mode} package may not declare it (a rule-authorized package must not masquerade as a human approval, nor the reverse)`);
    }
    if (!enablement.automationLevels.includes(level)) {
      c.add('AUTOMATION_LEVEL_NOT_ENABLED', '$.action.automationLevel.level', `automation Level ${level} is recognized by the contract but NOT_ENABLED by the current issuance/execution policy`);
    }
  }

  // --- risk facts ---
  const risk = authorization.risk;
  if (risk.basis === 'UNCLASSIFIED_FAIL_CLOSED_HIGH' && risk.riskClass !== 'high') c.add('RISK_INCONSISTENT', '$.authorization.risk', 'an unclassified action is treated as high');
  if (authorization.mode === 'HUMAN_APPROVAL' && authorization.risk.approverTier < authorization.risk.requiredApproverTier) {
    c.add('RISK_INCONSISTENT', '$.authorization.risk', 'approver tier is below the required tier: the risk policy did not pass');
  }

  // --- modification lineage (D-2, R-7) ---
  checkModification(c, body, contract ?? null);

  // --- timeline ---
  const authorizedAt = authorization.mode === 'HUMAN_APPROVAL' ? authorization.decidedAt : authorization.evaluatedAt;
  if (toMs(authorizedAt) > issuedMs) {
    c.add('TIMELINE_INCONSISTENT', authorization.mode === 'HUMAN_APPROVAL' ? '$.authorization.decidedAt' : '$.authorization.evaluatedAt', 'authorization is after issuance');
  }
  if (toMs(accountableOwner.assignment.assignedAt) > issuedMs) c.add('TIMELINE_INCONSISTENT', '$.accountableOwner.assignment.assignedAt', 'owner assignment is after issuance');
  if (toMs(validity.freshness.assessedAt) > issuedMs) c.add('TIMELINE_INCONSISTENT', '$.validity.freshness.assessedAt', 'freshness assessment is after issuance');
  if (accountableOwner.dueAt.state === 'VALUE' && toMs(accountableOwner.dueAt.value) <= toMs(accountableOwner.assignment.assignedAt)) c.add('TIMELINE_INCONSISTENT', '$.accountableOwner.dueAt', 'due date must be after the assignment');

  // --- validity (R-6) ---
  if (validity.isTimeSensitive && validity.decisionValidUntil.state !== 'VALUE') c.add('VALIDITY_INCONSISTENT', '$.validity.decisionValidUntil', 'a time-sensitive decision must carry valid_until');
  if (lineage.twinSnapshotId.state === 'VALUE' && validity.freshness.twin !== 'FRESH') c.add('VALIDITY_INCONSISTENT', '$.validity.freshness.twin', 'a package that references a Twin snapshot must have assessed it FRESH');
  if (lineage.twinSnapshotId.state === 'NOT_APPLICABLE' && validity.freshness.twin !== 'NOT_APPLICABLE') c.add('VALIDITY_INCONSISTENT', '$.validity.freshness.twin', 'no Twin snapshot is referenced, so freshness is NOT_APPLICABLE');

  const window = action.executionWindow;
  if (window.state === 'VALUE' && window.value.endsAt !== null && toMs(window.value.endsAt) <= toMs(window.value.startsAt)) c.add('WINDOW_INVALID', '$.action.executionWindow', 'window must end after it starts');

  const sources = new Set<ExpiryBoundSource>();
  for (const [i, b] of validity.expiryBounds.entries()) {
    if (sources.has(b.source)) c.add('EXPIRY_MISMATCH', `$.validity.expiryBounds[${i}]`, `duplicate bound ${b.source}`);
    sources.add(b.source);
  }
  const boundAt = (s: ExpiryBoundSource): string | undefined => validity.expiryBounds.find((b) => b.source === s)?.at;
  const expectedValidUntil = validity.decisionValidUntil.state === 'VALUE' ? validity.decisionValidUntil.value : undefined;
  if (boundAt('DECISION_VALID_UNTIL') !== expectedValidUntil) c.add('EXPIRY_MISMATCH', '$.validity.expiryBounds', 'the DECISION_VALID_UNTIL bound must equal the decision valid_until (and exist only when it does)');
  const expectedWindowEnd = window.state === 'VALUE' && window.value.endsAt !== null ? window.value.endsAt : undefined;
  if (boundAt('EXECUTION_WINDOW_END') !== expectedWindowEnd) c.add('EXPIRY_MISMATCH', '$.validity.expiryBounds', 'the EXECUTION_WINDOW_END bound must equal the execution window end (and exist only when it does)');
  const expectedExpiry = computePackageExpiry(validity.expiryBounds);
  if (expectedExpiry === null) {
    if (validity.expiresAt.state !== 'NOT_APPLICABLE') c.add('EXPIRY_MISMATCH', '$.validity.expiresAt', 'no bound applies, so expiresAt must be NOT_APPLICABLE');
    else checkNoBoundBasis(c, validity.expiresAt.reason, body.action, contract ?? null);
  } else if (validity.expiresAt.state !== 'VALUE' || validity.expiresAt.value !== expectedExpiry) {
    c.add('EXPIRY_MISMATCH', '$.validity.expiresAt', `expiresAt must be the earliest applicable bound (${expectedExpiry})`);
  }
  if (validity.expiresAt.state === 'VALUE' && toMs(validity.expiresAt.value) <= issuedMs) c.add('PACKAGE_EXPIRED', '$.validity.expiresAt', 'package would already be expired at issuance');

  // --- supplied validation time (database time) ---
  if (now !== undefined) {
    if (!isValidTimestamp(now)) {
      c.add('CONTEXT_INVALID', '$.now', 'validation time must be a UTC timestamp in YYYY-MM-DDTHH:mm:ss.sssZ form');
    } else {
      if (issuedMs > toMs(now)) c.add('ISSUED_IN_FUTURE', '$.issuance.issuedAt', 'package is issued after the validation time');
      if (validity.expiresAt.state === 'VALUE' && toMs(now) >= toMs(validity.expiresAt.value)) c.add('PACKAGE_EXPIRED', '$.validity.expiresAt', 'package has expired');
    }
  }
}

/**
 * A package with NO validity bound is legitimate only when an authoritative action schema or policy explicitly says no
 * bound applies. "No source found" is UNAVAILABLE (refused), never NOT_APPLICABLE.
 */
function checkNoBoundBasis(c: Collector, reason: NotApplicableReason, action: PackageAction, contract: ActionTypeContract | null): void {
  const path = '$.validity.expiresAt.reason';
  const basis = reason.basis;
  if (!basis) {
    c.add('NOT_APPLICABLE_NOT_PERMITTED', path, 'NOT_APPLICABLE expiry requires a governed applicability basis (an action schema or policy that explicitly says no validity bound applies); "no source found" is UNAVAILABLE');
    return;
  }
  if (basis.kind === 'ACTION_SCHEMA') {
    const expected = `${action.type.code}@${action.type.schemaVersion}`;
    if (basis.ref !== expected) c.add('NOT_APPLICABLE_NOT_PERMITTED', `${path}.basis.ref`, `the schema basis must reference this package's action type (${expected})`);
    else if (contract && contract.applicability.validityBound !== 'NOT_APPLICABLE_ALLOWED') c.add('NOT_APPLICABLE_NOT_PERMITTED', `${path}.basis`, `${expected} does not explicitly allow a package without a validity bound`);
  }
  // A POLICY basis names the governed policy version; it is carried and digest-covered. That the policy really says so is
  // verified by the issuer against the policy store (this contract is pure and cannot read it).
}

function checkActionConformance(c: Collector, body: AuthorizedActionPackageBody, contract: ActionTypeContract): void {
  const { action } = body;
  if (!contract.targetKinds.includes(action.target.kind)) c.add('ACTION_TARGET_KIND_INVALID', '$.action.target.kind', `target kind ${action.target.kind} is not allowed for ${contract.code}@${contract.schemaVersion}`);
  for (const name of Object.keys(action.parameters)) {
    const spec = Object.prototype.hasOwnProperty.call(contract.parameters, name) ? contract.parameters[name] : undefined;
    if (!spec) { c.add('ACTION_PARAMETER_UNKNOWN', `$.action.parameters.${name}`, 'parameter is not declared by the action type'); continue; }
    for (const problem of checkParameterValue(spec, action.parameters[name])) c.add('ACTION_PARAMETER_INVALID', `$.action.parameters.${name}`, problem);
  }
  for (const [name, spec] of Object.entries(contract.parameters)) {
    if (spec.required && !(name in action.parameters)) c.add('ACTION_PARAMETER_MISSING', `$.action.parameters.${name}`, 'required parameter is missing');
  }
  for (const field of ACTION_APPLICABILITY_FIELDS) {
    const governed = action[field] as Governed<unknown>;
    if (governed.state === 'NOT_APPLICABLE' && contract.applicability[field] !== 'NOT_APPLICABLE_ALLOWED') {
      c.add('NOT_APPLICABLE_NOT_PERMITTED', `$.action.${field}`, `${contract.code}@${contract.schemaVersion} requires ${field}; NOT_APPLICABLE is not permitted`);
    }
  }
}

function checkModification(c: Collector, body: AuthorizedActionPackageBody, contract: ActionTypeContract | null): void {
  const { lineage, authorization, action, issuance } = body;
  const { proposedParameters: proposed, modification, modificationEvaluation: evaluation } = lineage;
  // A rule-authorized package carries no human modification: it follows the plain-approval path.
  const status = authorization.mode === 'HUMAN_APPROVAL' ? authorization.decisionStatus : 'approved';

  if (status === 'approved') {
    if (modification.state === 'VALUE') c.add('MODIFICATION_NOT_ALLOWED', '$.lineage.modification', 'a plain approval carries no modification');
    if (evaluation.state === 'VALUE') c.add('MODIFICATION_NOT_ALLOWED', '$.lineage.modificationEvaluation', 'a plain approval carries no modification evaluation');
    if (proposed.state === 'VALUE' && !canonicalEqual(proposed.value.parameters, action.parameters)) {
      c.add('MODIFICATION_LINEAGE_INCONSISTENT', '$.action.parameters', 'a plain approval must authorize exactly the proposed parameters');
    }
    return;
  }

  // approved_with_modifications
  if (modification.state !== 'VALUE') { c.add('MODIFICATION_REQUIRED', '$.lineage.modification', 'approve_with_modifications requires a structured modification delta and reason'); return; }
  if (proposed.state !== 'VALUE') { c.add('MODIFICATION_LINEAGE_INCONSISTENT', '$.lineage.proposedParameters', 'a modification needs the original proposed parameter set it modifies'); return; }

  const original = proposed.value.parameters;
  const working: Record<string, JsonValue> = { ...original };
  const seen = new Set<string>();
  modification.value.changes.forEach((ch, i) => {
    const p = `$.lineage.modification.changes[${i}]`;
    if (seen.has(ch.parameter)) { c.add('MODIFICATION_LINEAGE_INCONSISTENT', p, `parameter ${ch.parameter} is changed more than once`); return; }
    seen.add(ch.parameter);
    const had = Object.prototype.hasOwnProperty.call(original, ch.parameter);
    const hasBefore = ch.before !== undefined;
    const hasAfter = ch.after !== undefined;
    if (ch.operation === 'ADD') {
      if (had || hasBefore || !hasAfter) c.add('MODIFICATION_LINEAGE_INCONSISTENT', p, 'ADD requires a parameter absent from the original and an `after` value only');
      else working[ch.parameter] = ch.after as JsonValue;
    } else if (ch.operation === 'REMOVE') {
      if (!had || !hasBefore || hasAfter || !canonicalEqual(ch.before, original[ch.parameter])) c.add('MODIFICATION_LINEAGE_INCONSISTENT', p, 'REMOVE requires the original value as `before` and no `after`');
      else delete working[ch.parameter];
    } else {
      if (!had || !hasBefore || !hasAfter || !canonicalEqual(ch.before, original[ch.parameter])) c.add('MODIFICATION_LINEAGE_INCONSISTENT', p, 'SET requires the original value as `before` and a new `after`');
      else if (canonicalEqual(ch.before, ch.after)) c.add('MODIFICATION_LINEAGE_INCONSISTENT', p, 'SET must change the value');
      else working[ch.parameter] = ch.after as JsonValue;
    }
  });
  if (!canonicalEqual(working, action.parameters)) c.add('MODIFICATION_LINEAGE_INCONSISTENT', '$.action.parameters', 'the effective parameters are not the original with the recorded delta applied');
  if (toMs(modification.value.modifiedAt) > toMs(issuance.issuedAt)) c.add('TIMELINE_INCONSISTENT', '$.lineage.modification.modifiedAt', 'modification is after issuance');

  // Fresh governance evaluation for execution-affecting modifications (D-2, R-7). Needs the action-type contract.
  if (!contract) return;
  const required = requiredGovernanceDimensions(contract, modification.value.changes.map((ch) => ch.parameter));
  if (required.dimensions.length === 0) return;
  if (evaluation.state !== 'VALUE') { c.add('MODIFICATION_EVALUATION_MISSING', '$.lineage.modificationEvaluation', `fresh evaluation is required for: ${required.dimensions.join(', ')}`); return; }
  if (evaluation.value.basis !== required.basis) c.add('MODIFICATION_EVALUATION_INVALID', '$.lineage.modificationEvaluation.basis', `basis must be ${required.basis}`);
  const covered = new Set<GovernanceDimension>();
  evaluation.value.evidence.forEach((ev, i) => {
    const p = `$.lineage.modificationEvaluation.evidence[${i}]`;
    if (covered.has(ev.dimension)) c.add('MODIFICATION_EVALUATION_INVALID', p, `duplicate evidence for ${ev.dimension}`);
    covered.add(ev.dimension);
    const at = toMs(ev.evaluatedAt);
    if (at < toMs(modification.value.modifiedAt)) c.add('MODIFICATION_EVALUATION_INVALID', p, 'evaluation predates the modification, so it is not fresh');
    if (at > toMs(issuance.issuedAt)) c.add('MODIFICATION_EVALUATION_INVALID', p, 'evaluation is after issuance');
  });
  for (const d of required.dimensions) if (!covered.has(d)) c.add('MODIFICATION_EVALUATION_MISSING', '$.lineage.modificationEvaluation.evidence', `no fresh evaluation for ${d}`);
}

// -------------------------------------------------------------------------------------------------------------------
// Entry points
// -------------------------------------------------------------------------------------------------------------------

export interface PackageValidationOptions {
  actionTypes: ActionTypeRegistry;
  /** Validation time (database time in production). When supplied, issuance and expiry are checked against it. */
  now?: string;
  /** Which recognized automation levels are enabled. Defaults to CURRENT_PACKAGE_ENABLEMENT (Level 4 is NOT_ENABLED). */
  enablement?: PackageEnablementPolicy;
}

const result = (c: Collector): AapValidationResult => ({ valid: c.count === 0, errors: c.errors });

/** Shared by the body and sealed validators. Returns the parsed body when structure and semantics are clean. An `integrity` key is unknown to the body contract. */
function validateBodyInternal(c: Collector, input: unknown, opts: PackageValidationOptions): AuthorizedActionPackageBody | undefined {
  if (!isRec(input)) { c.add('NOT_AN_OBJECT', '$', 'package must be an object'); return undefined; }

  // Contract version first: an unsupported version is never interpreted.
  if (typeof input.contractVersion !== 'string' || !SUPPORTED_AAP_CONTRACT_VERSIONS.includes(input.contractVersion)) {
    c.add('UNSUPPORTED_CONTRACT_VERSION', '$.contractVersion', `unsupported contract version; supported: ${SUPPORTED_AAP_CONTRACT_VERSIONS.join(', ')}`);
    return undefined;
  }

  // The whole input must be in the canonical JSON domain (no undefined, NaN, Date, bigint, cycles, lone surrogates).
  let canonicalLength: number;
  try { canonicalLength = canonicalize(input).length; } catch (e) {
    if (e instanceof CanonicalizationError) { c.add('FORBIDDEN_VALUE', e.path, e.reason); return undefined; }
    throw e;
  }
  if (canonicalLength > MAX_CANONICAL_CHARS) { c.add('FORBIDDEN_VALUE', '$', `package exceeds ${MAX_CANONICAL_CHARS} canonical characters`); return undefined; }

  scanForbiddenKeys(c, input, '$');
  scanUnavailable(c, input, '$');

  const body = parseBody(c, input);
  if (!body || c.count > 0) return undefined;
  checkSemantics(c, body, opts.actionTypes, opts.now, opts.enablement ?? CURRENT_PACKAGE_ENABLEMENT);
  return c.count === 0 ? body : undefined;
}

/** Validates an UNSEALED candidate (no `integrity` block). */
export function validatePackageBody(input: unknown, opts: PackageValidationOptions): AapValidationResult {
  const c = new Collector();
  validateBodyInternal(c, input, opts);
  return result(c);
}

/**
 * The ONLY function that creates a sealed package. It validates the candidate completely, then attaches the integrity
 * block. A candidate with any required UNAVAILABLE field, an unknown action type, an inconsistent modification, or
 * any other violation is refused with AuthorizedActionPackageInvalidError. Restricted to the issuer by architecture
 * test (R-8); the digest it adds is tamper evidence only.
 */
export function sealAuthorizedActionPackage(candidate: unknown, opts: PackageValidationOptions): AuthorizedActionPackageV1 {
  const c = new Collector();
  const body = validateBodyInternal(c, candidate, opts);
  if (!body || c.count > 0) throw new AuthorizedActionPackageInvalidError(c.errors);
  return { ...body, integrity: buildIntegrity(body) };
}

function checkIntegrity(c: Collector, input: Rec, body: AuthorizedActionPackageBody): void {
  const integ = readObject(c, '$.integrity', input.integrity, ['canonicalVersion', 'algorithm', 'digest']);
  if (!integ) return;
  if (typeof integ.canonicalVersion !== 'string' || !SUPPORTED_AAP_CANONICAL_VERSIONS.includes(integ.canonicalVersion)) {
    c.add('UNSUPPORTED_CANONICAL_VERSION', '$.integrity.canonicalVersion', `supported: ${SUPPORTED_AAP_CANONICAL_VERSIONS.join(', ')}`);
    return;
  }
  if (integ.algorithm !== AAP_DIGEST_ALGORITHM) { c.add('UNSUPPORTED_DIGEST_ALGORITHM', '$.integrity.algorithm', `supported: ${AAP_DIGEST_ALGORITHM}`); return; }
  if (!isWellFormedDigest(integ.digest)) { c.add('DIGEST_MALFORMED', '$.integrity.digest', 'must be sha256:<64 lowercase hex>'); return; }
  if (computePackageDigest(body) !== integ.digest) c.add('DIGEST_MISMATCH', '$.integrity.digest', 'the package content does not match its digest (tampered or substituted)');
}

/** Validates a SEALED package: structure, semantics, and the integrity digest. The digest is tamper evidence only. */
export function validateAuthorizedActionPackage(input: unknown, opts: PackageValidationOptions): AapValidationResult {
  const c = new Collector();
  if (!isRec(input)) { c.add('NOT_AN_OBJECT', '$', 'package must be an object'); return result(c); }
  if (!('integrity' in input)) { c.add('MISSING_FIELD', '$.integrity', 'a sealed package carries an integrity block'); }
  const { integrity: _integrity, ...rest } = input;
  const body = validateBodyInternal(c, rest, opts);
  if (body) checkIntegrity(c, input, body);
  else if ('integrity' in input) {
    // Even an otherwise-invalid package is checked for a malformed digest so every defect is reported once.
    const integ = input.integrity;
    if (isRec(integ) && integ.digest !== undefined && !isWellFormedDigest(integ.digest)) c.add('DIGEST_MALFORMED', '$.integrity.digest', 'must be sha256:<64 lowercase hex>');
  }
  return result(c);
}

// -------------------------------------------------------------------------------------------------------------------
// Pre-execution evaluation (Business Operations side; owner rulings D-3, R-5, R-10)
// -------------------------------------------------------------------------------------------------------------------

export interface ExecutionContext {
  actionTypes: ActionTypeRegistry;
  /** BO's own capability registry: can this executor run this action type at this schema version? */
  capabilities: ActionCapabilityRegistry;
  /** Database time at the moment of the check. */
  now: string;
  /** The scope BO is executing under (from its own authenticated context; never from the package). */
  scope: PackageScope;
  /** The ABA-authoritative status answer obtained immediately before execution. Missing or unverifiable = refuse. */
  status: AuthoritativePackageStatus | null | undefined;
  /** How old the status answer may be. Required: this contract invents no default. */
  statusMaxAgeMs: number;
  /** Which recognized automation levels are enabled for execution. Defaults to CURRENT_PACKAGE_ENABLEMENT. */
  enablement?: PackageEnablementPolicy;
}

/**
 * Everything BO must establish before executing. `valid` means EXECUTABLE (a derived result, never persisted).
 * Fails closed: if current authority cannot be verified the result is invalid (R-10). BO refusal does not alter ABA
 * approval; it is BO execution evidence (D-3).
 */
export function validateForExecution(input: unknown, ctx: ExecutionContext): AapValidationResult {
  const c = new Collector();

  if (!isValidTimestamp(ctx.now)) c.add('CONTEXT_INVALID', '$ctx.now', 'must be a UTC timestamp in YYYY-MM-DDTHH:mm:ss.sssZ form');
  if (!ctx.scope || !UUID.test(ctx.scope.tenantId) || !UUID.test(ctx.scope.workspaceId) || !UUID.test(ctx.scope.businessId)) c.add('CONTEXT_INVALID', '$ctx.scope', 'tenant, workspace and business ids are required');
  if (typeof ctx.statusMaxAgeMs !== 'number' || !Number.isFinite(ctx.statusMaxAgeMs) || ctx.statusMaxAgeMs < 0) c.add('CONTEXT_INVALID', '$ctx.statusMaxAgeMs', 'a non-negative maximum status age must be supplied');
  if (c.count > 0) return result(c);

  const structural = validateAuthorizedActionPackage(input, { actionTypes: ctx.actionTypes, now: ctx.now, ...(ctx.enablement ? { enablement: ctx.enablement } : {}) });
  for (const e of structural.errors) c.errors.push(e);
  if (!structural.valid) return result(c);

  const pkg = input as AuthorizedActionPackageV1;
  const nowMs = toMs(ctx.now);

  // Scope: BO executes only inside the scope it is authenticated for.
  if (pkg.scope.tenantId !== ctx.scope.tenantId) c.add('SCOPE_MISMATCH', '$.scope.tenantId', 'package belongs to a different tenant');
  if (pkg.scope.workspaceId !== ctx.scope.workspaceId) c.add('SCOPE_MISMATCH', '$.scope.workspaceId', 'package belongs to a different workspace');
  if (pkg.scope.businessId !== ctx.scope.businessId) c.add('SCOPE_MISMATCH', '$.scope.businessId', 'package belongs to a different business');

  // BO's own capability to execute this action type.
  if (!ctx.capabilities.supports(pkg.action.type.code, pkg.action.type.schemaVersion)) {
    c.add('ACTION_TYPE_UNSUPPORTED_BY_EXECUTOR', '$.action.type', `${pkg.action.type.code}@${pkg.action.type.schemaVersion} is not executable by this executor`);
  }

  // Execution window.
  // (The window END is always an expiry bound, so a closed window already fails validation as PACKAGE_EXPIRED above.)
  const w = pkg.action.executionWindow;
  if (w.state === 'VALUE' && nowMs < toMs(w.value.startsAt)) c.add('EXECUTION_WINDOW_NOT_OPEN', '$.action.executionWindow.startsAt', 'execution window has not opened');

  // Authoritative status (R-10): fail closed when it cannot be verified.
  checkStatus(c, pkg, ctx, nowMs);
  return result(c);
}

function checkStatus(c: Collector, pkg: AuthorizedActionPackageV1, ctx: ExecutionContext, nowMs: number): void {
  const s = ctx.status;
  if (!isRec(s)) { c.add('STATUS_UNVERIFIED', '$ctx.status', 'the authoritative package status could not be obtained; execution is refused'); return; }
  const st = s as unknown as Rec;
  const wellFormed =
    typeof st.packageId === 'string' && Number.isSafeInteger(st.packageVersion) && isWellFormedDigest(st.digest) &&
    typeof st.lifecycle === 'string' && (PACKAGE_LIFECYCLE_STATES as readonly string[]).includes(st.lifecycle) &&
    Number.isSafeInteger(st.latestPackageVersion) && isValidTimestamp(st.verifiedAt);
  if (!wellFormed) { c.add('STATUS_UNVERIFIED', '$ctx.status', 'the status answer is malformed; execution is refused'); return; }
  const status = s as AuthoritativePackageStatus;

  if (status.packageId !== pkg.identity.packageId || status.packageVersion !== pkg.identity.packageVersion || status.digest !== pkg.integrity.digest) {
    c.add('STATUS_UNVERIFIED', '$ctx.status', 'the status answer is not about this exact package (id, version and digest must all match)');
    return;
  }
  const verifiedMs = toMs(status.verifiedAt);
  if (verifiedMs > nowMs) { c.add('STATUS_UNVERIFIED', '$ctx.status.verifiedAt', 'the status answer is from the future'); return; }
  if (nowMs - verifiedMs > ctx.statusMaxAgeMs) { c.add('STATUS_UNVERIFIED', '$ctx.status.verifiedAt', 'the status answer is too old to rely on immediately before execution'); return; }
  if (status.latestPackageVersion < pkg.identity.packageVersion) { c.add('STATUS_UNVERIFIED', '$ctx.status.latestPackageVersion', 'the status answer is inconsistent with the package version'); return; }

  switch (status.lifecycle) {
    case 'REVOKED': c.add('PACKAGE_REVOKED', '$ctx.status.lifecycle', 'package has been revoked'); break;
    case 'SUPERSEDED': c.add('PACKAGE_SUPERSEDED', '$ctx.status.lifecycle', 'package has been superseded'); break;
    case 'EXPIRED': c.add('PACKAGE_EXPIRED', '$ctx.status.lifecycle', 'package has expired'); break;
    case 'CONSUMED': c.add('PACKAGE_ALREADY_CONSUMED', '$ctx.status.lifecycle', 'package is single-use and has already been claimed'); break;
    case 'ISSUED': break;
  }
  if (status.lifecycle === 'ISSUED' && status.latestPackageVersion > pkg.identity.packageVersion) c.add('PACKAGE_NOT_CURRENT_VERSION', '$ctx.status.latestPackageVersion', 'a newer package version exists');
}
