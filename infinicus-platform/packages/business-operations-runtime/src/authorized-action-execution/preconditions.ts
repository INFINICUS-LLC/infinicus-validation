/**
 * Execution preconditions (P0-6c; planning decision 9). The package carries `{code, operator, operand}` triples; this module gives the
 * codes a meaning. The vocabulary is Business Operations' own and deliberately small:
 *
 *   stock_available   the balance's `quantity_available` (exact decimal)
 *
 * An UNKNOWN CODE or an unsupported operator/operand is reported as unsupported - the engine then REFUSES. A precondition is never
 * ignored, guessed or coerced. Pure: no I/O, no clock. Numbers are compared as exact decimals (no binary floating point).
 */
import type { Precondition } from '@infinicus/handoff-contracts';
import { Decimal } from '../inventory-policy/decimal.js';

export interface PreconditionFacts {
  /** quantity_available of the locked target balance. */
  stock_available: Decimal;
}

export type PreconditionProblem = 'UNSUPPORTED_CODE' | 'UNSUPPORTED_OPERATOR' | 'OPERAND_INVALID';

export interface PreconditionResult {
  code: string;
  operator: string;
  operand: unknown;
  /** The observed value as exact decimal text; null when the code is unknown. */
  observed: string | null;
  /** True/false once evaluated; null when it could not be (see `problem`). */
  passed: boolean | null;
  problem: PreconditionProblem | null;
}

export interface PreconditionEvaluation {
  results: PreconditionResult[];
  /** At least one precondition could not be evaluated: the engine must refuse. */
  unsupported: boolean;
  /** At least one evaluated precondition is not met. */
  failed: boolean;
}

const num = (v: unknown): Decimal | null => Decimal.fromNumber(v);

function holds(operator: string, observed: Decimal, operand: unknown): { passed: boolean } | { problem: PreconditionProblem } {
  switch (operator) {
    case 'eq': case 'neq': case 'lt': case 'lte': case 'gt': case 'gte': {
      const o = num(operand);
      if (o === null) return { problem: 'OPERAND_INVALID' };
      const c = observed.cmp(o);
      return { passed: operator === 'eq' ? c === 0 : operator === 'neq' ? c !== 0 : operator === 'lt' ? c < 0 : operator === 'lte' ? c <= 0 : operator === 'gt' ? c > 0 : c >= 0 };
    }
    case 'between': {
      if (!Array.isArray(operand) || operand.length !== 2) return { problem: 'OPERAND_INVALID' };
      const lo = num(operand[0]); const hi = num(operand[1]);
      if (lo === null || hi === null || lo.cmp(hi) > 0) return { problem: 'OPERAND_INVALID' };
      return { passed: observed.gte(lo) && observed.lte(hi) };
    }
    case 'in': case 'not_in': {
      if (!Array.isArray(operand) || operand.length === 0) return { problem: 'OPERAND_INVALID' };
      const members = operand.map(num);
      if (members.some((m) => m === null)) return { problem: 'OPERAND_INVALID' };
      const member = (members as Decimal[]).some((m) => m.cmp(observed) === 0);
      return { passed: operator === 'in' ? member : !member };
    }
    default:
      return { problem: 'UNSUPPORTED_OPERATOR' };
  }
}

export function evaluatePreconditions(preconditions: readonly Precondition[], facts: PreconditionFacts): PreconditionEvaluation {
  const results: PreconditionResult[] = preconditions.map((p) => {
    if (p.code !== 'stock_available') {
      return { code: p.code, operator: p.operator, operand: p.operand, observed: null, passed: null, problem: 'UNSUPPORTED_CODE' as const };
    }
    const verdict = holds(p.operator, facts.stock_available, p.operand);
    const observed = facts.stock_available.toString();
    return 'problem' in verdict
      ? { code: p.code, operator: p.operator, operand: p.operand, observed, passed: null, problem: verdict.problem }
      : { code: p.code, operator: p.operator, operand: p.operand, observed, passed: verdict.passed, problem: null };
  });
  return { results, unsupported: results.some((r) => r.problem !== null), failed: results.some((r) => r.passed === false) };
}
