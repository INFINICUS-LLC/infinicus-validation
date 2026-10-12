-- Migration: 0198_link_purchase_order_lines_to_inventory_items
-- Data-capture Block D (docs/architecture/reconciliation/DATA-CAPTURE_RECONCILIATION_inventory-cost-receipts.md, section 3.D): reliable
-- purchase order -> purchase-order line -> receipt line -> receipt movement -> inventory item linkage.
--
--   * purchase_order_line_items gains a NULLABLE inventory_item_id (FK platform.inventory_items). The product link (product_id, catalog identity) is
--     untouched; the item link is the operational stock identity. No existing row is changed: existing lines stay NULL (no backfill, no product->item
--     inference - a product match does not prove which inventory item is the operational one).
--   * The FK is RESTRICT, not SET NULL: silently erasing a link that receipts may already rely on would break the chain.
--   * A write guard (insert, or update of the scope / purchase order / item columns) makes the DATABASE refuse a line whose purchase order or inventory
--     item is outside the line's own tenant/workspace/business, whatever the caller supplied or the FK allows. Rows that are not written again are
--     not re-judged (forward enforcement only; nothing historical is invented or repaired).
--   * The link may not be changed away from what receipts already recorded against the line: while any receipt line references the purchase-order line,
--     the line's item may not be cleared or set to a different item (receipt lines are append-only facts).
--   * The receipt-line guard from 0197 is replaced (CREATE OR REPLACE; 0197 is not edited) to add the chain rule: when the referenced purchase-order
--     line carries an inventory item, the receipt line must record that same item. A purchase-order line with NO item link is still accepted exactly as
--     in Block A; the item is never written back into the purchase-order line and nothing is inferred.
--
-- Out of scope (unchanged): supplier-to-item linkage, purchase-order status, received_qty, any purchase-order line write path. No GRANT or role
-- statements (role provisioning is environment-specific, see grant-app-role.sh). Idempotent.

BEGIN;

ALTER TABLE business_operations.purchase_order_line_items
  ADD COLUMN IF NOT EXISTS inventory_item_id uuid NULL REFERENCES platform.inventory_items(id) ON DELETE RESTRICT;

COMMENT ON COLUMN business_operations.purchase_order_line_items.inventory_item_id IS
  'Operational stock identity of the line (Data-capture Block D). Nullable: never inferred from the product link; NULL where no authoritative mapping exists. Must be in the line''s own tenant/workspace/business.';

CREATE INDEX IF NOT EXISTS idx_po_lines_item ON business_operations.purchase_order_line_items (inventory_item_id) WHERE inventory_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_prl_po_line   ON business_operations.purchase_receipt_lines (purchase_order_line_id) WHERE purchase_order_line_id IS NOT NULL;

CREATE OR REPLACE FUNCTION business_operations.guard_purchase_order_line_item_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM business_operations.purchase_orders po
                  WHERE po.id = NEW.purchase_order_id AND po.tenant_id = NEW.tenant_id AND po.workspace_id = NEW.workspace_id AND po.business_id = NEW.business_id) THEN
    RAISE EXCEPTION 'purchase_order_line_items: the purchase order does not belong to the stated tenant, workspace and business' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.inventory_item_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM platform.inventory_items i
        WHERE i.id = NEW.inventory_item_id AND i.tenant_id = NEW.tenant_id AND i.workspace_id = NEW.workspace_id AND i.business_id = NEW.business_id) THEN
    RAISE EXCEPTION 'purchase_order_line_items: the inventory item does not belong to the stated tenant, workspace and business' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.inventory_item_id IS DISTINCT FROM OLD.inventory_item_id AND EXISTS (
       SELECT 1 FROM business_operations.purchase_receipt_lines rl
        WHERE rl.purchase_order_line_id = NEW.id AND (NEW.inventory_item_id IS NULL OR rl.inventory_item_id <> NEW.inventory_item_id)) THEN
    RAISE EXCEPTION 'purchase_order_line_items: receipts already recorded against this line for another inventory item; its item link cannot be cleared or changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_purchase_order_line_item_write ON business_operations.purchase_order_line_items;
CREATE TRIGGER guard_purchase_order_line_item_write
  BEFORE INSERT OR UPDATE OF tenant_id, workspace_id, business_id, purchase_order_id, inventory_item_id ON business_operations.purchase_order_line_items
  FOR EACH ROW EXECUTE FUNCTION business_operations.guard_purchase_order_line_item_write();

-- Receipt-line guard: 0197's rules plus the chain rule (PO line item, when linked, equals the receipt line's item).
CREATE OR REPLACE FUNCTION business_operations.guard_purchase_receipt_line_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_po uuid;
  v_linked_item uuid;
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
  IF NEW.purchase_order_line_id IS NOT NULL THEN
    SELECT l.inventory_item_id INTO v_linked_item
      FROM business_operations.purchase_order_line_items l
     WHERE l.id = NEW.purchase_order_line_id AND l.purchase_order_id = v_po
       AND l.tenant_id = NEW.tenant_id AND l.workspace_id = NEW.workspace_id AND l.business_id = NEW.business_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'purchase_receipt_lines: the purchase-order line is not a line of the receipt''s purchase order in this business' USING ERRCODE = 'check_violation';
    END IF;
    IF v_linked_item IS NOT NULL AND v_linked_item <> NEW.inventory_item_id THEN
      RAISE EXCEPTION 'purchase_receipt_lines: the receipt line records a different inventory item than the purchase-order line it references' USING ERRCODE = 'check_violation';
    END IF;
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

INSERT INTO _migrations (filename) VALUES ('0198_link_purchase_order_lines_to_inventory_items.sql')
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
