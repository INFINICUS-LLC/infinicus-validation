-- POS2-04-S4: durable terminal outcomes for the unwired canonical BO sale-effect command.
-- S3 immutable source evidence remains unchanged; S4 has no producer, scheduling or API route.
BEGIN;
ALTER TABLE business_operations.inventory_movements
  ADD CONSTRAINT pos_sale_effect_movement_scope_unique UNIQUE (id, tenant_id, workspace_id, business_id);

CREATE TABLE business_operations.pos_inventory_sale_effect_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  effect_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  business_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('applied', 'exception')),
  reason text CHECK (reason IS NULL OR reason = 'INSUFFICIENT_STOCK'),
  movement_id uuid,
  order_line_id uuid NOT NULL,
  inventory_item_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  quantity numeric(18,4) NOT NULL CHECK (quantity > 0),
  available_quantity numeric(18,4) CHECK (available_quantity >= 0),
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT pos_sale_effect_outcome_effect_fk
    FOREIGN KEY (effect_id, tenant_id, workspace_id, business_id)
    REFERENCES business_operations.pos_inventory_sale_effects
      (id, tenant_id, workspace_id, business_id) ON DELETE RESTRICT,
  CONSTRAINT pos_sale_effect_outcome_movement_fk
    FOREIGN KEY (movement_id, tenant_id, workspace_id, business_id)
    REFERENCES business_operations.inventory_movements
      (id, tenant_id, workspace_id, business_id) ON DELETE RESTRICT,
  CONSTRAINT pos_sale_effect_one_terminal_outcome UNIQUE (effect_id),
  CONSTRAINT pos_sale_effect_one_movement UNIQUE (movement_id),
  CONSTRAINT pos_sale_effect_outcome_shape CHECK (
    (outcome = 'applied' AND movement_id IS NOT NULL AND reason IS NULL AND available_quantity IS NULL)
    OR (outcome = 'exception' AND movement_id IS NULL AND reason = 'INSUFFICIENT_STOCK' AND available_quantity IS NOT NULL)
  )
);

ALTER TABLE business_operations.pos_inventory_sale_effect_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_operations.pos_inventory_sale_effect_outcomes FORCE ROW LEVEL SECURITY;
CREATE POLICY pos_sale_effect_outcome_scope ON business_operations.pos_inventory_sale_effect_outcomes
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

CREATE FUNCTION business_operations.verify_pos_sale_effect_outcome()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_effect record;
  v_movement record;
BEGIN
  SELECT order_line_id, inventory_item_id, warehouse_id, effect_quantity, correlation_id
    INTO v_effect
    FROM business_operations.pos_inventory_sale_effects
   WHERE id = NEW.effect_id AND tenant_id = NEW.tenant_id
     AND workspace_id = NEW.workspace_id AND business_id = NEW.business_id;
  IF NOT FOUND OR v_effect.order_line_id IS DISTINCT FROM NEW.order_line_id
    OR v_effect.inventory_item_id IS DISTINCT FROM NEW.inventory_item_id
    OR v_effect.warehouse_id IS DISTINCT FROM NEW.warehouse_id
    OR v_effect.effect_quantity IS DISTINCT FROM NEW.quantity
    OR v_effect.correlation_id IS DISTINCT FROM NEW.correlation_id THEN
    RAISE EXCEPTION 'sale effect outcome: source evidence mismatch' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.outcome = 'applied' THEN
    SELECT movement_type, reference_type, reference_id, quantity, inventory_item_id,
           warehouse_id, correlation_id INTO v_movement
      FROM business_operations.inventory_movements
     WHERE id = NEW.movement_id AND tenant_id = NEW.tenant_id
       AND workspace_id = NEW.workspace_id AND business_id = NEW.business_id;
    IF NOT FOUND OR v_movement.movement_type IS DISTINCT FROM 'issue'
       OR v_movement.reference_type IS DISTINCT FROM 'order_line'
       OR v_movement.reference_id IS DISTINCT FROM NEW.order_line_id
       OR v_movement.quantity IS DISTINCT FROM NEW.quantity
       OR v_movement.inventory_item_id IS DISTINCT FROM NEW.inventory_item_id
       OR v_movement.warehouse_id IS DISTINCT FROM NEW.warehouse_id
       OR v_movement.correlation_id IS DISTINCT FROM NEW.correlation_id THEN
      RAISE EXCEPTION 'sale effect outcome: canonical movement mismatch' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER verify_pos_sale_effect_outcome
  BEFORE INSERT ON business_operations.pos_inventory_sale_effect_outcomes
  FOR EACH ROW EXECUTE FUNCTION business_operations.verify_pos_sale_effect_outcome();
CREATE TRIGGER forbid_pos_sale_effect_outcome_change
  BEFORE UPDATE OR DELETE ON business_operations.pos_inventory_sale_effect_outcomes
  FOR EACH ROW EXECUTE FUNCTION business_operations.forbid_mutation();
CREATE TRIGGER forbid_pos_sale_effect_outcome_truncate
  BEFORE TRUNCATE ON business_operations.pos_inventory_sale_effect_outcomes
  FOR EACH STATEMENT EXECUTE FUNCTION business_operations.forbid_mutation();

-- Application-role privileges are separately revoked by grant-app-role.sh.
INSERT INTO _migrations (filename) VALUES ('0230_pos_inventory_sale_effect_outcomes.sql')
  ON CONFLICT (filename) DO NOTHING;
COMMIT;
