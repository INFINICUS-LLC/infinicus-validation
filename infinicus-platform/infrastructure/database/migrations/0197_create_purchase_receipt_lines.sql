-- Migration: 0197_create_purchase_receipt_lines
-- Data-capture Block A (docs/architecture/reconciliation/DATA-CAPTURE_RECONCILIATION_inventory-cost-receipts.md, section 3.A): the purchase receipt
-- write path needs a place for what was received. `business_operations.purchase_receipts` (0026) is header-only; this adds the line table the
-- specification names: receipt, (optional) purchase-order line, inventory item, quantity, unit cost, cost currency - plus the ledger movement each line
-- created, so the movement ledger stays the ONE source for stock and cost (a receipt never duplicates balances).
--
--   * purchase_receipt_lines is an APPEND-ONLY BO fact (forbid_mutation, the repository convention discovered by delete-tenant-data.mjs), with FORCE
--     ROW LEVEL SECURITY on tenant + workspace.
--   * The invariants Blocks B and C established for movement cost hold from the first row (this is a new table, so nothing is NOT VALID):
--     cost present <=> currency present (^[A-Z]{3}$), cost > 0 and not NaN, quantity > 0 and not NaN. numeric(18,4) refuses Infinity and never
--     rounds silently because the writer checks the scale first.
--   * An insert guard makes the database refuse a line that is not exactly what the governed executor writes: the receipt, the item and (when given)
--     the purchase-order line must be in the SAME tenant/workspace/business (and the PO line on the receipt's purchase order), and the linked ledger
--     movement must be a `receipt` movement of that item and quantity/cost/currency, referencing this receipt.
--   * The receipt HEADER becomes append-only too: 0036 already lists purchase_receipts among the append-only tables ("NOT applied to append-only
--     tables ... purchase_receipts") but never enforced it. It has no writer and no reader that updates it, so no behaviour changes.
--
-- The purchase-order LINE reference is nullable by design: purchase-order lines have no write path yet and their item linkage is Data-capture Block D.
-- No backfill, no rewrite, no repair of any existing row; nothing is inferred. No GRANT or role statements (role provisioning is environment-specific,
-- see grant-app-role.sh). Idempotent.

BEGIN;

CREATE OR REPLACE FUNCTION business_operations.forbid_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'business_operations.%: append-only table - % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE TABLE IF NOT EXISTS business_operations.purchase_receipt_lines (
  id                     uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid          NOT NULL REFERENCES tenancy.tenants(id)                              ON DELETE RESTRICT,
  workspace_id           uuid          NOT NULL REFERENCES tenancy.workspaces(id)                           ON DELETE RESTRICT,
  business_id            uuid          NOT NULL REFERENCES platform.businesses(id)                          ON DELETE RESTRICT,
  purchase_receipt_id    uuid          NOT NULL REFERENCES business_operations.purchase_receipts(id)        ON DELETE RESTRICT,
  line_number            integer       NOT NULL CHECK (line_number > 0),
  purchase_order_line_id uuid          NULL     REFERENCES business_operations.purchase_order_line_items(id) ON DELETE RESTRICT,
  inventory_item_id      uuid          NOT NULL REFERENCES platform.inventory_items(id)                     ON DELETE RESTRICT,
  inventory_movement_id  uuid          NOT NULL REFERENCES business_operations.inventory_movements(id)      ON DELETE RESTRICT,
  quantity               numeric(18,4) NOT NULL,
  unit_cost              numeric(18,4) NULL,
  unit_cost_currency     text          NULL,
  correlation_id         uuid          NOT NULL,
  created_at             timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT purchase_receipt_lines_receipt_line_key UNIQUE (purchase_receipt_id, line_number),
  CONSTRAINT purchase_receipt_lines_movement_key UNIQUE (inventory_movement_id),
  CONSTRAINT purchase_receipt_lines_quantity_positive CHECK (quantity > 0 AND quantity <> 'NaN'::numeric),
  CONSTRAINT purchase_receipt_lines_unit_cost_positive CHECK (unit_cost IS NULL OR (unit_cost > 0 AND unit_cost <> 'NaN'::numeric)),
  CONSTRAINT purchase_receipt_lines_currency_format CHECK (unit_cost_currency IS NULL OR unit_cost_currency ~ '^[A-Z]{3}$'),
  CONSTRAINT purchase_receipt_lines_cost_currency_presence CHECK ((unit_cost IS NULL) = (unit_cost_currency IS NULL))
);

COMMENT ON TABLE business_operations.purchase_receipt_lines IS
  'Append-only lines of a purchase receipt (Data-capture Block A): what was received (item, quantity, optional cost and explicit cost currency) and the ledger movement each line created. The movement ledger remains the one source for stock and cost.';

CREATE INDEX IF NOT EXISTS idx_prl_receipt ON business_operations.purchase_receipt_lines (purchase_receipt_id);
CREATE INDEX IF NOT EXISTS idx_prl_item    ON business_operations.purchase_receipt_lines (inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_prl_tenant  ON business_operations.purchase_receipt_lines (tenant_id, workspace_id, business_id);

-- Insert guard: a line must be exactly what the governed executor writes, inside one tenant/workspace/business.
CREATE OR REPLACE FUNCTION business_operations.guard_purchase_receipt_line_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_po uuid;
BEGIN
  SELECT r.purchase_order_id INTO v_po
    FROM business_operations.purchase_receipts r
   WHERE r.id = NEW.purchase_receipt_id AND r.tenant_id = NEW.tenant_id AND r.workspace_id = NEW.workspace_id AND r.business_id = NEW.business_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'purchase_receipt_lines: the receipt does not belong to the stated tenant, workspace and business' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM platform.inventory_items i WHERE i.id = NEW.inventory_item_id AND i.tenant_id = NEW.tenant_id AND i.workspace_id = NEW.workspace_id AND i.business_id = NEW.business_id) THEN
    RAISE EXCEPTION 'purchase_receipt_lines: the inventory item does not belong to the stated tenant, workspace and business' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.purchase_order_line_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM business_operations.purchase_order_line_items l
        WHERE l.id = NEW.purchase_order_line_id AND l.purchase_order_id = v_po
          AND l.tenant_id = NEW.tenant_id AND l.workspace_id = NEW.workspace_id AND l.business_id = NEW.business_id) THEN
    RAISE EXCEPTION 'purchase_receipt_lines: the purchase-order line is not a line of the receipt''s purchase order in this business' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM business_operations.inventory_movements m
        WHERE m.id = NEW.inventory_movement_id AND m.tenant_id = NEW.tenant_id AND m.workspace_id = NEW.workspace_id AND m.business_id = NEW.business_id
          AND m.inventory_item_id = NEW.inventory_item_id AND m.movement_type = 'receipt'
          AND m.reference_type = 'purchase_receipt' AND m.reference_id = NEW.purchase_receipt_id
          AND m.quantity = NEW.quantity
          AND m.unit_cost IS NOT DISTINCT FROM NEW.unit_cost
          AND m.unit_cost_currency IS NOT DISTINCT FROM NEW.unit_cost_currency) THEN
    RAISE EXCEPTION 'purchase_receipt_lines: the line does not match its ledger movement (a receipt movement of this item, quantity, cost and currency referencing this receipt)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_purchase_receipt_line_insert ON business_operations.purchase_receipt_lines;
CREATE TRIGGER guard_purchase_receipt_line_insert
  BEFORE INSERT ON business_operations.purchase_receipt_lines
  FOR EACH ROW EXECUTE FUNCTION business_operations.guard_purchase_receipt_line_insert();

-- Append-only: lines and the receipt header. UPDATE, DELETE and TRUNCATE are refused for every role.
DROP TRIGGER IF EXISTS forbid_mutation_purchase_receipt_lines ON business_operations.purchase_receipt_lines;
CREATE TRIGGER forbid_mutation_purchase_receipt_lines
  BEFORE UPDATE OR DELETE ON business_operations.purchase_receipt_lines
  FOR EACH ROW EXECUTE FUNCTION business_operations.forbid_mutation();
DROP TRIGGER IF EXISTS forbid_truncate_purchase_receipt_lines ON business_operations.purchase_receipt_lines;
CREATE TRIGGER forbid_truncate_purchase_receipt_lines
  BEFORE TRUNCATE ON business_operations.purchase_receipt_lines
  FOR EACH STATEMENT EXECUTE FUNCTION business_operations.forbid_mutation();

DROP TRIGGER IF EXISTS forbid_mutation_purchase_receipts ON business_operations.purchase_receipts;
CREATE TRIGGER forbid_mutation_purchase_receipts
  BEFORE UPDATE OR DELETE ON business_operations.purchase_receipts
  FOR EACH ROW EXECUTE FUNCTION business_operations.forbid_mutation();
DROP TRIGGER IF EXISTS forbid_truncate_purchase_receipts ON business_operations.purchase_receipts;
CREATE TRIGGER forbid_truncate_purchase_receipts
  BEFORE TRUNCATE ON business_operations.purchase_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION business_operations.forbid_mutation();

-- Row-level security: tenant + workspace, forced (owner included), like inventory_movements (0035 + 0186).
ALTER TABLE business_operations.purchase_receipt_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_operations.purchase_receipt_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS purchase_receipt_lines_isolation ON business_operations.purchase_receipt_lines;
CREATE POLICY purchase_receipt_lines_isolation ON business_operations.purchase_receipt_lines
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid AND workspace_id = current_setting('app.workspace_id', true)::uuid);

INSERT INTO _migrations (filename) VALUES ('0197_create_purchase_receipt_lines.sql')
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
