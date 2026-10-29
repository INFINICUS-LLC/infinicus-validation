/**
 * R-01A (DAL-3): the operational preparation profile.
 *
 * Declares which manual-record shapes the DAL prepares for hand-off to Business Operations and the deterministic rules applied to them. The DAL does
 * not import Business Operations (architecture guard); this profile mirrors the BO intake contract for the record types it covers and a BO-side
 * drift-guard test asserts that every record the DAL accepts here also passes the BO mapper.
 *
 * Normalization is lossless and never fabricates: it trims, applies Unicode NFC, lower-cases closed enumerations, converts plain decimal strings to
 * numbers and restates explicit-offset instants in UTC. A value that cannot be normalized that way is rejected with a reason, never guessed.
 * Currency is deliberately not normalized (owner ruling, Block C): it is accepted only exactly as supplied.
 */

/** Selector: a manual submission opts in to preparation by using this submissionType. Any other submissionType keeps the legacy behavior. */
export const OPERATIONS_PREPARED_SUBMISSION_TYPE = 'operations_prepared';
export const OPERATIONAL_PROFILE_VERSION = '1.0';
export const NORMALIZE_TRANSFORMATION_TYPE = 'normalize';

export const PREPARED_RECORD_TYPES = ['inventory_item', 'warehouse', 'inventory_movement'] as const;
export type PreparedRecordType = (typeof PREPARED_RECORD_TYPES)[number];

export const INVENTORY_MOVEMENT_TYPES = [
  'receipt', 'issue', 'transfer_in', 'transfer_out', 'adjustment', 'return', 'write_off', 'cycle_count',
] as const;
export const MOVEMENT_REFERENCE_TYPES = ['purchase_receipt', 'order_line', 'transfer', 'adjustment', 'manual', 'other'] as const;

/** Mirrors BO SKU_PATTERN / currency pattern / unit-cost floor (numeric(18,4)). Parity is asserted by a BO-side drift-guard test. */
export const NATURAL_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;
export const UNIT_COST_MINIMUM = 0.0001;
export const MAX_NAME_LENGTH = 200;
export const MAX_UNIT_OF_MEASURE_LENGTH = 40;

/**
 * Column contracts the prepared numbers must satisfy exactly: business_operations.inventory_movements.quantity and .unit_cost are numeric(18,4).
 * A PostgreSQL integration test compares these constants with the live columns, so a schema change cannot silently desynchronize them.
 */
export const MOVEMENT_QUANTITY_CONTRACT = { precision: 18, scale: 4 } as const;
export const MOVEMENT_UNIT_COST_CONTRACT = { precision: 18, scale: 4 } as const;
/** An ISO-8601 instant that states its own offset. Date-only and offset-less values are refused: the DAL will not invent a time or a zone. */
export const OFFSET_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/** Upper bound applied BEFORE the instant pattern runs, so matching cost is bounded by construction. */
export const MAX_INSTANT_STRING_LENGTH = 40;
