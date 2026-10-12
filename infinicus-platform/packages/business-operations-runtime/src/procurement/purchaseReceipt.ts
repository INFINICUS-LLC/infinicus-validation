/**
 * Data-capture Block A - the one rule set of a purchase receipt, shared by the intake mapper and the BO executor so the two can never drift.
 *
 * A receipt names its purchase order and warehouse, carries a business receipt number (unique per business) and one or more lines. Each line is an
 * inventory item, a strictly positive quantity and an OPTIONAL cost that must be positive, storable and explicitly currency-tagged (Blocks B and C). Nothing is
 * defaulted, inferred, rounded or coerced: a value the database column (`numeric(18,4)`) could not store exactly is refused here instead.
 *
 * Pure: no database, no clock, no I/O.
 */
import { Decimal } from '../inventory-policy/decimal.js';
import { unitCostProblem } from '../unitCost.js';
import type { RecordPurchaseReceiptCommand } from '../types.js';

/** Upper bound on the lines of ONE receipt (an operational safety bound, not a business rule). */
export const PURCHASE_RECEIPT_MAX_LINES = 500;
export const PURCHASE_RECEIPT_NUMBER_MAX_LENGTH = 100;
export const PURCHASE_RECEIPT_NOTES_MAX_LENGTH = 2000;
/** quantity and unit cost are numeric(18,4): at most 4 decimal places and strictly less than 10^14. */
export const PURCHASE_RECEIPT_AMOUNT_MAX_DECIMALS = 4;
const AMOUNT_EXCLUSIVE_MAX = Decimal.of(10n ** 14n);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CURRENCY = /^[A-Z]{3}$/;
/** RFC 3339 with an explicit offset: the instant is stated, never assumed to be local or UTC. */
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

export const PURCHASE_RECEIPT_FIELDS = ['purchaseOrderId', 'warehouseId', 'receiptNumber', 'receivedAt', 'notes', 'lines'] as const;
export const PURCHASE_RECEIPT_LINE_FIELDS = ['purchaseOrderLineId', 'inventoryItemId', 'quantity', 'unitCost', 'unitCostCurrency'] as const;

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Why a quantity or amount cannot be stored exactly, or null when it can. Never rounds. */
export function receiptAmountProblem(value: unknown): 'not_finite' | 'not_positive' | 'excess_scale' | 'out_of_range' | null {
  const d = Decimal.fromNumber(value);
  if (d === null) return 'not_finite';
  if (d.isNegative() || d.isZero()) return 'not_positive';
  if (d.scale > PURCHASE_RECEIPT_AMOUNT_MAX_DECIMALS) return 'excess_scale';
  if (d.gte(AMOUNT_EXCLUSIVE_MAX)) return 'out_of_range';
  return null;
}

/**
 * Every reason a purchase-receipt payload (the DAL record's `data`, or a command payload) is refused; empty when it is valid. Unknown fields are
 * refused so a caller can never smuggle a scope (tenant, workspace, business) or any other value the contract does not define.
 */
export function purchaseReceiptProblems(data: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(data)) return ['receipt_must_be_an_object'];
  for (const key of Object.keys(data)) if (!(PURCHASE_RECEIPT_FIELDS as readonly string[]).includes(key)) errors.push(`${key}_not_allowed`);

  for (const key of ['purchaseOrderId', 'warehouseId'] as const) {
    if (typeof data[key] !== 'string') errors.push(`${key}_required`);
    else if (!UUID.test(data[key] as string)) errors.push(`${key}_invalid`);
  }
  const number = data.receiptNumber;
  if (typeof number !== 'string' || number.trim().length === 0) errors.push('receiptNumber_required');
  else if (number !== number.trim() || number.length > PURCHASE_RECEIPT_NUMBER_MAX_LENGTH) errors.push('receiptNumber_invalid');
  const at = data.receivedAt;
  if (typeof at !== 'string') errors.push('receivedAt_required');
  else if (!RFC3339.test(at) || Number.isNaN(Date.parse(at))) errors.push('receivedAt_invalid');
  if (data.notes !== undefined && data.notes !== null && (typeof data.notes !== 'string' || data.notes.trim().length === 0 || data.notes.length > PURCHASE_RECEIPT_NOTES_MAX_LENGTH)) errors.push('notes_invalid');

  const lines = data.lines;
  if (!Array.isArray(lines) || lines.length === 0) errors.push('lines_required');
  else if (lines.length > PURCHASE_RECEIPT_MAX_LINES) errors.push('lines_too_many');
  else {
    lines.forEach((line, i) => {
      const at = (reason: string) => errors.push(`lines[${i}].${reason}`);
      if (!isRecord(line)) return at('line_must_be_an_object');
      for (const key of Object.keys(line)) if (!(PURCHASE_RECEIPT_LINE_FIELDS as readonly string[]).includes(key)) at(`${key}_not_allowed`);
      if (typeof line.inventoryItemId !== 'string') at('inventoryItemId_required');
      else if (!UUID.test(line.inventoryItemId)) at('inventoryItemId_invalid');
      if (line.purchaseOrderLineId !== undefined && line.purchaseOrderLineId !== null && (typeof line.purchaseOrderLineId !== 'string' || !UUID.test(line.purchaseOrderLineId))) at('purchaseOrderLineId_invalid');
      if (line.quantity === undefined || line.quantity === null) at('quantity_required');
      else {
        const problem = receiptAmountProblem(line.quantity);
        if (problem) at(`quantity_${problem}`);
      }
      const hasCost = line.unitCost !== undefined && line.unitCost !== null;
      const hasCurrency = line.unitCostCurrency !== undefined && line.unitCostCurrency !== null;
      if (hasCost) {
        const shared = unitCostProblem(line.unitCost); // Block B: the ONE cost-validity rule (finite, > 0, >= 0.0001)
        const scale = receiptAmountProblem(line.unitCost);
        if (shared === 'not_finite' || scale === 'not_finite') at('unitCost_invalid');
        else if (shared === 'not_positive') at('unitCost_not_positive');
        else if (shared === 'below_minimum_precision') at('unitCost_below_minimum_precision');
        else if (scale) at(`unitCost_${scale}`);
      }
      if (hasCurrency && (typeof line.unitCostCurrency !== 'string' || !CURRENCY.test(line.unitCostCurrency))) at('unitCostCurrency_invalid'); // exact: no trimming, no case folding
      // Cost and currency travel together (Block C). Nothing is ever filled in from a default, the purchase order or the business.
      if (hasCost && !hasCurrency) at('unitCostCurrency_required_with_unitCost');
      if (!hasCost && hasCurrency) at('unitCost_required_with_unitCostCurrency');
    });
  }
  return errors;
}

/** The business content of a receipt in a fixed shape with exact decimal text: what "the same receipt" means for replay and conflict detection. */
export interface CanonicalReceiptContent {
  purchaseOrderId: string;
  warehouseId: string;
  receivedAt: string;
  notes: string | null;
  lines: { lineNumber: number; purchaseOrderLineId: string | null; inventoryItemId: string; quantity: string; unitCost: string | null; unitCostCurrency: string | null }[];
}

/** Call only with a payload that has no problems. Line numbers are the 1-based position in the receipt. */
export function canonicalReceiptContent(p: RecordPurchaseReceiptCommand['payload']): CanonicalReceiptContent {
  return {
    purchaseOrderId: p.purchaseOrderId,
    warehouseId: p.warehouseId,
    receivedAt: new Date(p.receivedAt).toISOString(),
    notes: p.notes ?? null,
    lines: p.lines.map((line, i) => ({
      lineNumber: i + 1,
      purchaseOrderLineId: line.purchaseOrderLineId ?? null,
      inventoryItemId: line.inventoryItemId,
      quantity: (Decimal.fromNumber(line.quantity) as Decimal).toString(),
      unitCost: line.unitCost === undefined || line.unitCost === null ? null : (Decimal.fromNumber(line.unitCost) as Decimal).toString(),
      unitCostCurrency: line.unitCostCurrency ?? null,
    })),
  };
}

/** Deterministic JSON text (object keys sorted recursively): equality of content must not depend on key order, which PostgreSQL `jsonb` does not preserve. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
