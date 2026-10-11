/**
 * Data-capture Block B - the validity rule for a movement's unit cost, shared by the intake mapper and the BO executor so the two can never drift.
 *
 * A unit cost stays optional, but when it is present it must be a finite, strictly positive amount that the database column can actually
 * store. `inventory_movements.unit_cost` is `numeric(18,4)`, so the smallest positive cost it can hold is 0.0001; anything smaller would be
 * silently rounded to zero by PostgreSQL. Such a value is refused explicitly here instead of being rounded or coerced.
 */
export const UNIT_COST_MINIMUM_STORABLE = 0.0001;

export type UnitCostProblem = 'not_finite' | 'not_positive' | 'below_minimum_precision';

/** Returns why a unit cost is invalid, or null when it is valid. */
export function unitCostProblem(value: unknown): UnitCostProblem | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'not_finite';
  if (value <= 0) return 'not_positive';
  if (value < UNIT_COST_MINIMUM_STORABLE) return 'below_minimum_precision';
  return null;
}
