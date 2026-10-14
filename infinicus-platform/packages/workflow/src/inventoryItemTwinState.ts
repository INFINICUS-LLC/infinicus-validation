/**
 * The modeled present-state of one inventory item (AC-2 Block 6), derived purely from Business Intelligence evidence. Pure and database-free.
 *
 * This is a MODEL, not operational truth: it states derived quantities the decision chain needs (average daily demand, days of cover, where stock sits relative
 * to the current policy) and REFERENCES the BI evidence and BO fact digest it was derived from. It never restates raw BO facts as authoritative (no on-hand
 * copy, no cost) and is never an input to an operational mutation: Business Operations alone decides and the BO evaluator reads BO truth, not this state.
 */
export const INVENTORY_ITEM_TWIN_STATE_SCHEMA = 'inventory-item-twin-state/1';
export const INVENTORY_ITEM_TWIN_MODEL = Object.freeze({ name: 'inventory-item-state', version: '1', method: 'DETERMINISTIC_RATIO' });

export type PolicyPosition = 'POLICY_UNSET' | 'AT_OR_BELOW_REORDER_POINT' | 'ABOVE_REORDER_POINT';

export interface InventoryItemTwinDerivationInput {
  demandUnits: number;
  demandObservations: number;
  windowDays: number;
  onHandUnits: number;
  reorderPoint: number;
  reorderQuantity: number;
}

export interface InventoryItemTwinDerived {
  /** Units issued per day over the window (demand / windowDays), 4 decimals. */
  avgDailyDemand: number;
  /** On hand / average daily demand, 2 decimals; null when there was no demand to cover (never infinite, never guessed). */
  daysOfCover: number | null;
  policyPosition: PolicyPosition;
  demandObservations: number;
  windowDays: number;
}

const round = (v: number, dp: number): number => Number(v.toFixed(dp));

/** Returns the derived state, or a problem string when the evidence cannot support a model (non-finite, negative, or a non-positive window). */
export function deriveInventoryItemTwinState(i: InventoryItemTwinDerivationInput): { ok: true; derived: InventoryItemTwinDerived } | { ok: false; problem: string } {
  for (const [name, v] of Object.entries({ demandUnits: i.demandUnits, onHandUnits: i.onHandUnits, reorderPoint: i.reorderPoint, reorderQuantity: i.reorderQuantity })) {
    if (!Number.isFinite(v) || v < 0) return { ok: false, problem: `${name} must be a finite, non-negative number` };
  }
  if (!Number.isInteger(i.windowDays) || i.windowDays <= 0) return { ok: false, problem: 'windowDays must be a positive integer' };
  if (!Number.isInteger(i.demandObservations) || i.demandObservations < 0) return { ok: false, problem: 'demandObservations must be a non-negative integer' };
  const avg = i.demandUnits / i.windowDays;
  const policyPosition: PolicyPosition = i.reorderPoint === 0 && i.reorderQuantity === 0 ? 'POLICY_UNSET' : (i.onHandUnits <= i.reorderPoint ? 'AT_OR_BELOW_REORDER_POINT' : 'ABOVE_REORDER_POINT');
  return { ok: true, derived: { avgDailyDemand: round(avg, 4), daysOfCover: avg > 0 ? round(i.onHandUnits / avg, 2) : null, policyPosition, demandObservations: i.demandObservations, windowDays: i.windowDays } };
}
