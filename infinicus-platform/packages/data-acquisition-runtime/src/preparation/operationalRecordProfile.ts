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

export const PREPARED_RECORD_TYPES = ['inventory_item', 'warehouse', 'inventory_movement', 'purchase_order', 'operational_fact', 'workforce_event', 'asset_inspection', 'supplier_performance', 'purchase_receipt'] as const;
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
/** The purchase-order total column is numeric(18,4) as well; the same live-schema parity test covers it. */
export const PURCHASE_ORDER_TOTAL_CONTRACT = { precision: 18, scale: 4 } as const;
/**
 * R-01B-4: business_operations.business_events.amount and .quantity are numeric(18,4) with no CHECK, so negatives and zero are storable and are not
 * rejected here. The live-schema parity test covers these constants too.
 */
export const OPERATIONAL_FACT_AMOUNT_CONTRACT = { precision: 18, scale: 4 } as const;
export const OPERATIONAL_FACT_QUANTITY_CONTRACT = { precision: 18, scale: 4 } as const;
/** Mirror the BO operational_fact mapper enums (and the business_events CHECKs); parity is asserted by a BO-side drift-guard test. */
export const OPERATIONAL_FACT_EVENT_TYPES = ['sale', 'expense', 'inventory', 'customer', 'team'] as const;
export const OPERATIONAL_FACT_ACTIONS = ['new', 'return', 'churn', 'hire', 'fire', 'review'] as const;
/** An ISO-8601 instant that states its own offset. Date-only and offset-less values are refused: the DAL will not invent a time or a zone. */
export const OFFSET_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/** Upper bound applied BEFORE the instant pattern runs, so matching cost is bounded by construction. */
export const MAX_INSTANT_STRING_LENGTH = 40;

/**
 * R-01B-2: prepared-key duplicate/conflict detection. The DAL only REPORTS; Business Operations remains the final validator and sole writer.
 * Identity and comparison rules mirror what BO enforces today (OperationalCommandExecutor.createInventoryItem / createWarehouse); a BO-side agreement
 * test runs the same cases through BO and fails if the two ever diverge. Inventory movements have no BO identity contract and are never classified.
 */
export const PREPARED_KEY_RULE_CODES = {
  exactDuplicate: 'PREP_EXACT_DUPLICATE',
  conflict: 'PREP_CONFLICT',
  normalizationCollision: 'PREP_NORMALIZATION_COLLISION',
} as const;
/** BO stores this when an inventory item states no unit of measure (the INSERT's coalesce); a later record is compared against the stored value. */
export const INVENTORY_ITEM_DEFAULT_UNIT_OF_MEASURE = 'unit';

/**
 * R-01B-5: workforce events are stored in business_operations.business_events as event_type 'team' (hours -> quantity numeric(18,4), memberId -> member_id
 * text). The action enum mirrors the BO workforce_event mapper (narrower than the table CHECK); parity is asserted by a BO-side drift-guard test.
 */
export const WORKFORCE_EVENT_ACTIONS = ['hire', 'fire', 'review'] as const;
export const WORKFORCE_EVENT_HOURS_CONTRACT = { precision: 18, scale: 4 } as const;

/**
 * R-01B-6: enums of the BO asset_inspection mapper (identical to the asset_inspections CHECK constraints; parity is asserted by a PostgreSQL integration test
 * and a BO-side drift-guard test).
 */
export const ASSET_INSPECTION_TYPES = ['routine', 'safety', 'regulatory', 'pre_use', 'post_use', 'other'] as const;
export const ASSET_CONDITION_RATINGS = ['excellent', 'good', 'fair', 'poor', 'critical'] as const;

/**
 * R-01B-7: the five supplier_performance_scores score columns are numeric(5,2) with CHECK (0 <= score <= 100). BO's mapper checks only the range, so a value
 * with more than two decimals would be rounded silently by the column; the DAL refuses such a value instead. A PostgreSQL integration test compares these
 * constants with the live columns.
 */
export const SUPPLIER_SCORE_CONTRACT = { precision: 5, scale: 2 } as const;
export const SUPPLIER_SCORE_MINIMUM = 0;
export const SUPPLIER_SCORE_MAXIMUM = 100;
export const SUPPLIER_SCORE_FIELDS = ['qualityScore', 'deliveryScore', 'priceScore', 'serviceScore', 'overallScore'] as const;

/**
 * R-01B-8: the purchase_receipt contract of Business Operations (src/procurement/purchaseReceipt.ts), mirrored because the DAL cannot import it. A BO-side
 * drift-guard test fails if the two diverge. Receipt identifiers follow the owner ruling: LOWER-CASE canonical UUIDs only (no case folding, no widening).
 */
export const RECEIPT_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const PURCHASE_RECEIPT_MAX_LINES = 500;
export const PURCHASE_RECEIPT_NUMBER_MAX_LENGTH = 100;
export const PURCHASE_RECEIPT_NOTES_MAX_LENGTH = 2000;
/** purchase_receipt_lines.quantity and .unit_cost are numeric(18,4); covered by the live-schema parity test. */
export const RECEIPT_LINE_QUANTITY_CONTRACT = { precision: 18, scale: 4 } as const;
export const RECEIPT_LINE_UNIT_COST_CONTRACT = { precision: 18, scale: 4 } as const;
