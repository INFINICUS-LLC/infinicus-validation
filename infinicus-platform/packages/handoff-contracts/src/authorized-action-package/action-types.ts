// Versioned action-type contract (P0-5 Block 2; owner ruling R-1, R-7).
//
// ABA governs authorization semantics: an action-type contract declares, for one (code, schemaVersion), which target
// kinds and parameters exist, what each parameter may hold, which governance dimensions each parameter influences
// (R-7), and which governed fields may legitimately be NOT_APPLICABLE (D-6). This module defines the INTERFACE only.
// It ships no concrete action vocabulary: the vocabulary and its persistence are a later block's decision.
//
// Business Operations later maintains its own capability registry of executable action types/schema versions
// ({@link ActionCapabilityRegistry}); "BO can execute this" is a BO fact, "this is a valid authorized action" is ABA's.

import { GOVERNANCE_DIMENSIONS } from './types';
import { isDecimalString, isDottedNumeric } from './primitives';
import type { GovernanceDimension, JsonValue } from './types';

/** Governed fields whose NOT_APPLICABLE status an action-type contract decides. Unlisted = REQUIRED (fail closed). */
export const ACTION_APPLICABILITY_FIELDS = ['executionWindow', 'preconditions', 'budget', 'rollback', 'monitoring'] as const;
export type ActionApplicabilityField = (typeof ACTION_APPLICABILITY_FIELDS)[number];
export type ApplicabilityRule = 'REQUIRED' | 'NOT_APPLICABLE_ALLOWED';

export type ParameterSpec =
  | { readonly type: 'string'; readonly required: boolean; readonly maxLength?: number }
  | { readonly type: 'integer'; readonly required: boolean; readonly min?: number; readonly max?: number }
  | { readonly type: 'number'; readonly required: boolean; readonly min?: number; readonly max?: number }
  /** A decimal carried as a string, e.g. "12.50" (no floating-point ambiguity). */
  | { readonly type: 'decimal_string'; readonly required: boolean }
  | { readonly type: 'boolean'; readonly required: boolean }
  | { readonly type: 'enum'; readonly required: boolean; readonly values: readonly string[] }
  /** An opaque identifier: 1-128 characters of [A-Za-z0-9._:-]. */
  | { readonly type: 'identifier'; readonly required: boolean };

export interface ActionTypeContract {
  /** Action-type code in the ABA-governed vocabulary. */
  readonly code: string;
  /** Version of this action type's parameter schema. */
  readonly schemaVersion: string;
  /** Target kinds this action may address. */
  readonly targetKinds: readonly string[];
  /** The only parameters this action type accepts. Undeclared parameters are rejected. */
  readonly parameters: Readonly<Record<string, ParameterSpec>>;
  /**
   * Parameter -> governance dimensions it influences (R-7). A parameter ABSENT from this map has UNKNOWN impact and is
   * treated conservatively (every dimension). An explicit empty list declares "influences no governance dimension".
   */
  readonly governanceImpact: Readonly<Record<string, readonly GovernanceDimension[]>>;
  /** Which governed fields may be NOT_APPLICABLE for this action type. Anything not listed is REQUIRED. */
  readonly applicability: Readonly<Partial<Record<ActionApplicabilityField, ApplicabilityRule>>>;
}

/** Resolves the ABA-governed action-type contract for a (code, schemaVersion), or null when it is unknown. */
export interface ActionTypeRegistry {
  resolve(code: string, schemaVersion: string): ActionTypeContract | null;
}

/** BO-side capability registry: can this executor run this action type at this schema version? Owned by Business Operations. */
export interface ActionCapabilityRegistry {
  supports(code: string, schemaVersion: string): boolean;
}

/** A simple in-memory registry (tests, fixtures, and as the loading target for a persisted vocabulary). */
export class InMemoryActionTypeRegistry implements ActionTypeRegistry, ActionCapabilityRegistry {
  private readonly byKey = new Map<string, ActionTypeContract>();

  constructor(contracts: readonly ActionTypeContract[] = []) {
    for (const c of contracts) this.register(c);
  }

  register(contract: ActionTypeContract): void {
    const problems = validateActionTypeContract(contract);
    if (problems.length > 0) throw new Error(`invalid action type contract ${contract.code}@${contract.schemaVersion}: ${problems.join('; ')}`);
    const key = `${contract.code}@${contract.schemaVersion}`;
    if (this.byKey.has(key)) throw new Error(`duplicate action type contract ${key}`);
    this.byKey.set(key, contract);
  }

  resolve(code: string, schemaVersion: string): ActionTypeContract | null {
    return this.byKey.get(`${code}@${schemaVersion}`) ?? null;
  }

  supports(code: string, schemaVersion: string): boolean {
    return this.byKey.has(`${code}@${schemaVersion}`);
  }
}

const CODE_PATTERN = /^[a-z][a-z0-9_]*$/;
const PARAMETER_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** Structural problems with an action-type contract itself (empty = well formed). */
export function validateActionTypeContract(contract: ActionTypeContract): string[] {
  const problems: string[] = [];
  if (!CODE_PATTERN.test(contract.code)) problems.push('code must match [a-z][a-z0-9_]*');
  if (!isDottedNumeric(contract.schemaVersion)) problems.push('schemaVersion must be dotted numeric');
  if (!Array.isArray(contract.targetKinds) || contract.targetKinds.length === 0) problems.push('at least one target kind is required');
  const names = Object.keys(contract.parameters);
  if (names.length === 0) problems.push('at least one parameter is required');
  for (const name of names) {
    if (!PARAMETER_NAME_PATTERN.test(name)) problems.push(`parameter name ${name} is invalid`);
    const spec = contract.parameters[name];
    if (spec.type === 'enum' && (spec.values.length === 0 || new Set(spec.values).size !== spec.values.length)) problems.push(`enum ${name} needs unique values`);
    if ((spec.type === 'integer' || spec.type === 'number') && spec.min !== undefined && spec.max !== undefined && spec.min > spec.max) problems.push(`range for ${name} is empty`);
  }
  for (const [name, dims] of Object.entries(contract.governanceImpact)) {
    if (!(name in contract.parameters)) problems.push(`governanceImpact references undeclared parameter ${name}`);
    for (const d of dims) if (!(GOVERNANCE_DIMENSIONS as readonly string[]).includes(d)) problems.push(`unknown governance dimension ${d} for ${name}`);
  }
  for (const [field, rule] of Object.entries(contract.applicability)) {
    if (!(ACTION_APPLICABILITY_FIELDS as readonly string[]).includes(field)) problems.push(`applicability references unknown field ${field}`);
    if (rule !== 'REQUIRED' && rule !== 'NOT_APPLICABLE_ALLOWED') problems.push(`applicability rule for ${field} is invalid`);
  }
  return problems;
}

/** Problems with one parameter value against its spec (empty = valid). */
export function checkParameterValue(spec: ParameterSpec, value: JsonValue): string[] {
  switch (spec.type) {
    case 'string':
      if (typeof value !== 'string' || value.length === 0) return ['must be a non-empty string'];
      if (spec.maxLength !== undefined && value.length > spec.maxLength) return [`longer than ${spec.maxLength} characters`];
      return [];
    case 'integer':
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) return ['must be a safe integer'];
      if (spec.min !== undefined && value < spec.min) return [`below minimum ${spec.min}`];
      if (spec.max !== undefined && value > spec.max) return [`above maximum ${spec.max}`];
      return [];
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return ['must be a finite number'];
      if (spec.min !== undefined && value < spec.min) return [`below minimum ${spec.min}`];
      if (spec.max !== undefined && value > spec.max) return [`above maximum ${spec.max}`];
      return [];
    case 'decimal_string':
      return typeof value === 'string' && isDecimalString(value.startsWith('-') ? value.slice(1) : value) ? [] : ['must be a decimal string such as "12.50"'];
    case 'boolean':
      return typeof value === 'boolean' ? [] : ['must be a boolean'];
    case 'enum':
      return typeof value === 'string' && spec.values.includes(value) ? [] : [`must be one of: ${spec.values.join(', ')}`];
    case 'identifier':
      return typeof value === 'string' && IDENTIFIER_PATTERN.test(value) ? [] : ['must be an identifier of 1-128 characters [A-Za-z0-9._:-]'];
  }
}

/**
 * The governance dimensions that a set of changed parameters requires fresh evaluation for (R-7). A parameter whose
 * impact is not declared is UNKNOWN and forces every dimension (conservative full re-evaluation). No thresholds.
 */
export function requiredGovernanceDimensions(
  contract: ActionTypeContract,
  changedParameters: readonly string[],
): { dimensions: readonly GovernanceDimension[]; basis: 'DECLARED_IMPACT' | 'CONSERVATIVE_FULL' } {
  const required = new Set<GovernanceDimension>();
  let conservative = false;
  for (const parameter of changedParameters) {
    const declared = Object.prototype.hasOwnProperty.call(contract.governanceImpact, parameter) ? contract.governanceImpact[parameter] : undefined;
    if (declared === undefined) {
      conservative = true;
    } else {
      for (const d of declared) required.add(d);
    }
  }
  if (conservative) return { dimensions: [...GOVERNANCE_DIMENSIONS], basis: 'CONSERVATIVE_FULL' };
  return { dimensions: GOVERNANCE_DIMENSIONS.filter((d) => required.has(d)), basis: 'DECLARED_IMPACT' };
}
