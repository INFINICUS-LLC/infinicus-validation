/** AC-2 Block 6 - the pure derivation of an inventory item's modeled state. No database. */
import { describe, expect, it } from 'vitest';
import { deriveInventoryItemTwinState, INVENTORY_ITEM_TWIN_MODEL, INVENTORY_ITEM_TWIN_STATE_SCHEMA } from '../src/inventoryItemTwinState.js';

const base = { demandUnits: 900, demandObservations: 12, windowDays: 90, onHandUnits: 100, reorderPoint: 170, reorderQuantity: 190 };
const ok = (over: Partial<typeof base> = {}) => { const r = deriveInventoryItemTwinState({ ...base, ...over }); if (!r.ok) throw new Error(r.problem); return r.derived; };

describe('deriveInventoryItemTwinState', () => {
  it('derives average daily demand, days of cover and the policy position from the evidence', () => {
    expect(ok()).toEqual({ avgDailyDemand: 10, daysOfCover: 10, policyPosition: 'AT_OR_BELOW_REORDER_POINT', demandObservations: 12, windowDays: 90 });
    expect(ok({ onHandUnits: 400 })).toMatchObject({ daysOfCover: 40, policyPosition: 'ABOVE_REORDER_POINT' });
    expect(ok({ onHandUnits: 170 }).policyPosition).toBe('AT_OR_BELOW_REORDER_POINT'); // at the point counts as at-or-below
  });
  it('rounds the modeled ratios (4 and 2 decimals) and never reports infinite cover', () => {
    expect(ok({ demandUnits: 100, onHandUnits: 7 })).toMatchObject({ avgDailyDemand: 1.1111, daysOfCover: 6.3 });
    expect(ok({ demandUnits: 0, demandObservations: 0 })).toMatchObject({ avgDailyDemand: 0, daysOfCover: null });
  });
  it('an unconfigured policy (0/0) is POLICY_UNSET, never "below the point"', () => {
    expect(ok({ reorderPoint: 0, reorderQuantity: 0 }).policyPosition).toBe('POLICY_UNSET');
    expect(ok({ reorderPoint: 0, reorderQuantity: 10, onHandUnits: 0 }).policyPosition).toBe('AT_OR_BELOW_REORDER_POINT');
  });
  it('refuses evidence that cannot support a model: negative, non-finite, a bad window or bad observation count', () => {
    for (const bad of [{ demandUnits: -1 }, { onHandUnits: Number.NaN }, { reorderPoint: Number.POSITIVE_INFINITY }, { reorderQuantity: -5 }, { windowDays: 0 }, { windowDays: 1.5 }, { demandObservations: -1 }, { demandObservations: 2.5 }]) {
      expect(deriveInventoryItemTwinState({ ...base, ...bad }).ok, JSON.stringify(bad)).toBe(false);
    }
  });
  it('states its schema and model so the state is self-describing', () => {
    expect(INVENTORY_ITEM_TWIN_STATE_SCHEMA).toBe('inventory-item-twin-state/1');
    expect(INVENTORY_ITEM_TWIN_MODEL).toEqual({ name: 'inventory-item-state', version: '1', method: 'DETERMINISTIC_RATIO' });
  });
});
