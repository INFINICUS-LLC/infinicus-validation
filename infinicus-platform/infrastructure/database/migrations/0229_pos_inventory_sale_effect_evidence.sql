-- POS2-04-S3: inert, immutable evidence for an eligible completed native POS order line.
-- No producer, pull processor, stock movement, shortage handling or payment-path change.
BEGIN;

-- Existing IDs are individually unique; these composite keys also pin evidence to its order and BO scope.
ALTER TABLE business_operations.order_line_items
  ADD CONSTRAINT pos_sale_effect_line_scope_unique UNIQUE (id, order_id, tenant_id, workspace_id, business_id);
ALTER TABLE business_operations.order_events
  ADD CONSTRAINT pos_sale_effect_completion_scope_unique UNIQUE (id, order_id, tenant_id, workspace_id, business_id);

CREATE TABLE business_operations.pos_inventory_sale_effects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenancy.tenants(id) ON DELETE RESTRICT,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspaces(id) ON DELETE RESTRICT,
  business_id uuid NOT NULL REFERENCES platform.businesses(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL,
  order_line_id uuid NOT NULL,
  completion_event_id uuid NOT NULL,
  catalog_product_id uuid NOT NULL REFERENCES business_operations.products(id) ON DELETE RESTRICT,
  mapping_id uuid NOT NULL,
  inventory_item_id uuid NOT NULL REFERENCES platform.inventory_items(id) ON DELETE RESTRICT,
  warehouse_id uuid NOT NULL REFERENCES platform.warehouses(id) ON DELETE RESTRICT,
  inventory_unit_of_measure text NOT NULL,
  sale_line_quantity numeric(18,4) NOT NULL CHECK (sale_line_quantity > 0),
  unit_conversion_factor numeric NOT NULL CHECK (unit_conversion_factor = 1),
  effect_quantity numeric(18,4) NOT NULL CHECK (effect_quantity > 0),
  completed_at timestamptz NOT NULL,
  correlation_id uuid NOT NULL,
  contract_version text NOT NULL DEFAULT 'pos-inventory-sale-effect/1'
    CHECK (contract_version = 'pos-inventory-sale-effect/1'),
  state text NOT NULL DEFAULT 'pending' CHECK (state = 'pending'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT pos_sale_effect_line_scope FOREIGN KEY (order_line_id, order_id, tenant_id, workspace_id, business_id)
    REFERENCES business_operations.order_line_items (id, order_id, tenant_id, workspace_id, business_id) ON DELETE RESTRICT,
  CONSTRAINT pos_sale_effect_completion_scope FOREIGN KEY (completion_event_id, order_id, tenant_id, workspace_id, business_id)
    REFERENCES business_operations.order_events (id, order_id, tenant_id, workspace_id, business_id) ON DELETE RESTRICT,
  CONSTRAINT pos_sale_effect_mapping_scope FOREIGN KEY (mapping_id, tenant_id, workspace_id, business_id)
    REFERENCES business_operations.pos_inventory_mappings (id, tenant_id, workspace_id, business_id) ON DELETE RESTRICT,
  -- Current S2 permits one active mapping per product. Permanently pin one effect per
  -- order line, even if mapping deactivation/replacement happens before a replay.
  CONSTRAINT pos_sale_effect_one_per_line UNIQUE (order_line_id),
  CONSTRAINT pos_sale_effect_line_mapping_unique UNIQUE (order_line_id, mapping_id),
  CONSTRAINT pos_sale_effect_scope_id UNIQUE (id, tenant_id, workspace_id, business_id),
  CONSTRAINT pos_sale_effect_quantity_exact CHECK (effect_quantity = sale_line_quantity * unit_conversion_factor)
);

CREATE INDEX pos_sale_effect_scope_state ON business_operations.pos_inventory_sale_effects
  (tenant_id, workspace_id, business_id, state, created_at, id);

ALTER TABLE business_operations.pos_inventory_sale_effects ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_operations.pos_inventory_sale_effects FORCE ROW LEVEL SECURITY;
CREATE POLICY pos_sale_effect_scope ON business_operations.pos_inventory_sale_effects
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

-- The trigger validates the factual snapshot even against privileged direct inserts.
-- S3 deliberately grants no producer; S5 will add a separately governed, callable producer.
CREATE FUNCTION business_operations.verify_pos_inventory_sale_effect()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_line record;
  v_event record;
  v_mapping record;
  v_note_count bigint;
  v_item_ok boolean;
  v_warehouse_ok boolean;
BEGIN
  IF NEW.state IS DISTINCT FROM 'pending' OR NEW.contract_version IS DISTINCT FROM 'pos-inventory-sale-effect/1' THEN
    RAISE EXCEPTION 'sale effect: inert pending contract required' USING ERRCODE = 'check_violation';
  END IF;
  SELECT l.quantity, l.item_type INTO v_line
    FROM business_operations.order_line_items l
    JOIN platform.orders o ON o.id = l.order_id AND o.tenant_id = l.tenant_id
      AND o.workspace_id = l.workspace_id AND o.business_id = l.business_id
   WHERE l.id = NEW.order_line_id AND l.order_id = NEW.order_id
     AND l.tenant_id = NEW.tenant_id AND l.workspace_id = NEW.workspace_id
     AND l.business_id = NEW.business_id AND o.operational_status = 'completed'
   FOR SHARE OF l, o;
  IF NOT FOUND OR v_line.item_type IS DISTINCT FROM 'product' OR v_line.quantity IS DISTINCT FROM NEW.sale_line_quantity THEN
    RAISE EXCEPTION 'sale effect: eligible completed order line required' USING ERRCODE = 'check_violation';
  END IF;

  SELECT e.occurred_at, e.correlation_id INTO v_event
    FROM business_operations.order_events e
   WHERE e.id = NEW.completion_event_id AND e.order_id = NEW.order_id
     AND e.tenant_id = NEW.tenant_id AND e.workspace_id = NEW.workspace_id
     AND e.business_id = NEW.business_id
     AND e.event_type = 'completed' AND e.new_status = 'completed';
  IF NOT FOUND OR v_event.occurred_at IS DISTINCT FROM NEW.completed_at
     OR v_event.correlation_id IS DISTINCT FROM NEW.correlation_id THEN
    RAISE EXCEPTION 'sale effect: verified completion event required' USING ERRCODE = 'check_violation';
  END IF;

  SELECT m.catalog_product_id, m.inventory_item_id, m.warehouse_id,
         m.inventory_unit_of_measure, m.unit_conversion_factor, m.state
    INTO v_mapping
    FROM business_operations.pos_inventory_mappings m
   WHERE m.id = NEW.mapping_id AND m.tenant_id = NEW.tenant_id
     AND m.workspace_id = NEW.workspace_id AND m.business_id = NEW.business_id;
  IF NOT FOUND OR v_mapping.state <> 'active'
     OR v_mapping.catalog_product_id IS DISTINCT FROM NEW.catalog_product_id
     OR v_mapping.inventory_item_id IS DISTINCT FROM NEW.inventory_item_id
     OR v_mapping.warehouse_id IS DISTINCT FROM NEW.warehouse_id
     OR v_mapping.inventory_unit_of_measure IS DISTINCT FROM NEW.inventory_unit_of_measure
     OR v_mapping.unit_conversion_factor IS DISTINCT FROM NEW.unit_conversion_factor THEN
    RAISE EXCEPTION 'sale effect: active mapping snapshot mismatch' USING ERRCODE = 'check_violation';
  END IF;

  SELECT count(*) INTO v_note_count
    FROM business_operations.order_events e
   WHERE e.order_id = NEW.order_id AND e.tenant_id = NEW.tenant_id
     AND e.workspace_id = NEW.workspace_id AND e.business_id = NEW.business_id
     AND e.event_type = 'note' AND e.occurred_at <= NEW.completed_at
     AND e.payload ->> 'kind' = 'catalog_line_added'
     AND e.payload ->> 'lineItemId' = NEW.order_line_id::text
     AND e.payload ->> 'catalogProductId' = NEW.catalog_product_id::text;
  IF v_note_count <> 1 OR EXISTS (
    SELECT 1 FROM business_operations.order_events e
     WHERE e.order_id = NEW.order_id AND e.tenant_id = NEW.tenant_id
       AND e.workspace_id = NEW.workspace_id AND e.business_id = NEW.business_id
       AND e.event_type = 'note' AND e.payload ->> 'kind' = 'catalog_line_added'
       AND e.payload ->> 'lineItemId' = NEW.order_line_id::text
       AND e.payload ->> 'catalogProductId' IS DISTINCT FROM NEW.catalog_product_id::text
  ) THEN
    RAISE EXCEPTION 'sale effect: unambiguous catalogue-line provenance required' USING ERRCODE = 'check_violation';
  END IF;

  SELECT EXISTS (SELECT 1 FROM platform.inventory_items i
    WHERE i.id = NEW.inventory_item_id AND i.tenant_id = NEW.tenant_id
      AND i.workspace_id = NEW.workspace_id AND i.business_id = NEW.business_id
      AND i.status = 'active' AND i.unit_of_measure = NEW.inventory_unit_of_measure)
    INTO v_item_ok;
  SELECT EXISTS (SELECT 1 FROM platform.warehouses w
    WHERE w.id = NEW.warehouse_id AND w.tenant_id = NEW.tenant_id
      AND w.workspace_id = NEW.workspace_id AND w.business_id = NEW.business_id
      AND w.status = 'active') INTO v_warehouse_ok;
  IF NOT v_item_ok OR NOT v_warehouse_ok THEN
    RAISE EXCEPTION 'sale effect: active same-business stock target required' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.effect_quantity IS DISTINCT FROM NEW.sale_line_quantity * NEW.unit_conversion_factor THEN
    RAISE EXCEPTION 'sale effect: exact quantity mismatch' USING ERRCODE = 'check_violation';
  END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END $$;

CREATE TRIGGER verify_pos_inventory_sale_effect
  BEFORE INSERT ON business_operations.pos_inventory_sale_effects
  FOR EACH ROW EXECUTE FUNCTION business_operations.verify_pos_inventory_sale_effect();

CREATE TRIGGER forbid_pos_inventory_sale_effect_change
  BEFORE UPDATE OR DELETE ON business_operations.pos_inventory_sale_effects
  FOR EACH ROW EXECUTE FUNCTION business_operations.forbid_mutation();
CREATE TRIGGER forbid_pos_inventory_sale_effect_truncate
  BEFORE TRUNCATE ON business_operations.pos_inventory_sale_effects
  FOR EACH STATEMENT EXECUTE FUNCTION business_operations.forbid_mutation();

-- Application-role writes and reads are explicitly withheld in grant-app-role.sh.
-- No callable producer, route, dispatch, movement or change to POS completion in S3.
INSERT INTO _migrations (filename) VALUES ('0229_pos_inventory_sale_effect_evidence.sql')
  ON CONFLICT (filename) DO NOTHING;
COMMIT;
