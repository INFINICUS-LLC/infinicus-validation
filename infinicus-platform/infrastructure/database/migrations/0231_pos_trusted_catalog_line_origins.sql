-- POS2-04-S5A: immutable, privileged catalogue-line provenance at the line creation boundary.
-- Development only. Historical notes are NOT backfilled or trusted. No sale-effect producer/processor.
BEGIN;

-- No FK to the draft line: POS permits removing lines before completion. The immutable
-- origin remains as a non-authoritative tombstone if its draft line is deleted.
-- Both S3 and S4 require the original line to exist and match this exact scope.
CREATE TABLE business_operations.pos_catalog_line_origins (
  order_line_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  business_id uuid NOT NULL,
  order_id uuid NOT NULL,
  catalog_product_id uuid NOT NULL REFERENCES business_operations.products(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('online','offline_catalog','offline_honoured_drift')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT pos_catalog_line_origin_line_scope UNIQUE (order_line_id, order_id, tenant_id, workspace_id, business_id)
);
CREATE INDEX pos_catalog_line_origins_scope ON business_operations.pos_catalog_line_origins
  (tenant_id, workspace_id, business_id, order_id);
ALTER TABLE business_operations.pos_catalog_line_origins ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_operations.pos_catalog_line_origins FORCE ROW LEVEL SECURITY;
CREATE POLICY pos_catalog_line_origins_scope ON business_operations.pos_catalog_line_origins
  USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid
    AND workspace_id = nullif(current_setting('app.workspace_id',true),'')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid
    AND workspace_id = nullif(current_setting('app.workspace_id',true),'')::uuid);

-- Retain existing legitimate order-line removal/quantity-edit behavior. Never
-- let a retained or removed draft line gain a catalogue identity retrospectively.
CREATE FUNCTION business_operations.guard_pos_catalog_line_origin()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'POS catalogue origin: immutable provenance' USING ERRCODE='check_violation';
  END IF;
  IF current_user IS DISTINCT FROM (
    SELECT pg_get_userbyid(proowner) FROM pg_proc
     WHERE oid='business_operations.create_pos_catalog_line(uuid,uuid,uuid,uuid,integer,uuid,numeric,numeric,numeric,uuid,text)'::regprocedure)
     OR current_setting('app.pos_catalog_origin_writer',true) IS DISTINCT FROM 'create' THEN
    RAISE EXCEPTION 'POS catalogue origin: governed writer required' USING ERRCODE='insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_pos_catalog_line_origin
  BEFORE INSERT OR UPDATE OR DELETE ON business_operations.pos_catalog_line_origins
  FOR EACH ROW EXECUTE FUNCTION business_operations.guard_pos_catalog_line_origin();
CREATE TRIGGER refuse_pos_catalog_line_origin_truncate
  BEFORE TRUNCATE ON business_operations.pos_catalog_line_origins
  FOR EACH STATEMENT EXECUTE FUNCTION business_operations.forbid_mutation();

-- One entry point: creates the line and private origin in the SAME transaction.
-- It has no 'attach existing line' operation. It cannot authenticate a historical note.
CREATE FUNCTION business_operations.create_pos_catalog_line(
  p_tenant uuid, p_workspace uuid, p_business uuid, p_order uuid,
  p_line_number integer, p_product uuid, p_qty numeric,
  p_unit_price numeric, p_line_total numeric, p_actor uuid, p_source text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_product record; v_order record; v_line uuid;
BEGIN
  IF p_tenant IS NULL OR p_workspace IS NULL OR p_business IS NULL
     OR p_order IS NULL OR p_product IS NULL OR p_actor IS NULL
     OR p_line_number IS NULL OR p_line_number < 1
     OR p_qty IS NULL OR p_qty <= 0 OR p_qty >= 100000000000000
     OR p_unit_price IS NULL OR p_unit_price < 0
     OR p_line_total IS NULL OR p_line_total < 0 OR p_source NOT IN
       ('online','offline_catalog','offline_honoured_drift') THEN
    RAISE EXCEPTION 'POS catalogue line: invalid input' USING ERRCODE='invalid_parameter_value';
  END IF;
  IF nullif(current_setting('app.tenant_id',true),'')::uuid IS DISTINCT FROM p_tenant
     OR nullif(current_setting('app.workspace_id',true),'')::uuid IS DISTINCT FROM p_workspace
     OR nullif(current_setting('app.user_id',true),'')::uuid IS DISTINCT FROM p_actor THEN
    RAISE EXCEPTION 'POS catalogue line: transaction scope mismatch' USING ERRCODE='insufficient_privilege';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM tenancy.memberships m
    JOIN tenancy.membership_roles mr ON mr.membership_id=m.id
    JOIN tenancy.roles r ON r.id=mr.role_id
    JOIN tenancy.role_permissions rp ON rp.role_id=r.id
    JOIN tenancy.permissions perm ON perm.id=rp.permission_id
    WHERE m.tenant_id=p_tenant AND m.workspace_id=p_workspace AND m.user_id=p_actor
      AND m.status='active' AND (r.tenant_id IS NULL OR r.tenant_id=p_tenant)
      AND (mr.business_id IS NULL OR mr.business_id=p_business)
      AND perm.code='bo:write'
  ) THEN
    RAISE EXCEPTION 'POS catalogue line: current bo:write authority required' USING ERRCODE='insufficient_privilege';
  END IF;

  SELECT id, operational_status, currency_code INTO v_order FROM platform.orders o
   WHERE o.id=p_order AND o.tenant_id=p_tenant AND o.workspace_id=p_workspace AND o.business_id=p_business
   FOR UPDATE;
  IF NOT FOUND OR v_order.operational_status IS DISTINCT FROM 'planned' THEN
    RAISE EXCEPTION 'POS catalogue line: only scoped planned orders are writable' USING ERRCODE='check_violation';
  END IF;
  SELECT id, name, price INTO v_product FROM business_operations.products p
   WHERE p.id=p_product AND p.tenant_id=p_tenant AND p.workspace_id=p_workspace
      AND p.business_id=p_business AND p.active=true FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'POS catalogue line: active same-business product required' USING ERRCODE='check_violation';
  END IF;
  IF p_source <> 'offline_honoured_drift' AND p_unit_price IS DISTINCT FROM v_product.price THEN
    RAISE EXCEPTION 'POS catalogue line: canonical unit price required' USING ERRCODE='check_violation';
  END IF;
  IF p_source='offline_honoured_drift' AND p_unit_price IS NOT DISTINCT FROM v_product.price THEN
    RAISE EXCEPTION 'POS catalogue line: drift override must differ from canonical price' USING ERRCODE='check_violation';
  END IF;

  INSERT INTO business_operations.order_line_items
    (tenant_id,workspace_id,business_id,order_id,line_number,item_type,product_id,
     description,quantity,unit_price,line_total)
  VALUES (p_tenant,p_workspace,p_business,p_order,p_line_number,'product',NULL,
          v_product.name,p_qty,p_unit_price,p_line_total)
  RETURNING id INTO v_line;
  PERFORM set_config('app.pos_catalog_origin_writer','create',true);
  INSERT INTO business_operations.pos_catalog_line_origins
    (order_line_id,tenant_id,workspace_id,business_id,order_id,catalog_product_id,actor_user_id,source_kind)
  VALUES (v_line,p_tenant,p_workspace,p_business,p_order,p_product,p_actor,p_source);
  PERFORM set_config('app.pos_catalog_origin_writer','',true);
  RETURN v_line;
END $$;
REVOKE ALL ON FUNCTION business_operations.create_pos_catalog_line(
  uuid,uuid,uuid,uuid,integer,uuid,numeric,numeric,numeric,uuid,text) FROM PUBLIC;

-- Only origins created inside the authenticated line writer can satisfy S3.
-- Legacy 'catalog_line_added' notes are deliberately no longer considered proof.
CREATE OR REPLACE FUNCTION business_operations.verify_pos_inventory_sale_effect()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_line record; v_event record; v_mapping record; v_item_ok boolean; v_warehouse_ok boolean;
BEGIN
  IF NEW.state IS DISTINCT FROM 'pending' OR NEW.contract_version IS DISTINCT FROM 'pos-inventory-sale-effect/1' THEN
    RAISE EXCEPTION 'sale effect: inert pending contract required' USING ERRCODE='check_violation';
  END IF;
  SELECT l.quantity,l.item_type INTO v_line FROM business_operations.order_line_items l
  JOIN platform.orders o ON o.id=l.order_id AND o.tenant_id=l.tenant_id
    AND o.workspace_id=l.workspace_id AND o.business_id=l.business_id
  WHERE l.id=NEW.order_line_id AND l.order_id=NEW.order_id AND l.tenant_id=NEW.tenant_id
    AND l.workspace_id=NEW.workspace_id AND l.business_id=NEW.business_id
    AND o.operational_status='completed' FOR SHARE OF l,o;
  IF NOT FOUND OR v_line.item_type IS DISTINCT FROM 'product'
    OR v_line.quantity IS DISTINCT FROM NEW.sale_line_quantity THEN
    RAISE EXCEPTION 'sale effect: eligible completed order line required' USING ERRCODE='check_violation';
  END IF;
  SELECT e.occurred_at,e.correlation_id INTO v_event FROM business_operations.order_events e
  WHERE e.id=NEW.completion_event_id AND e.order_id=NEW.order_id AND e.tenant_id=NEW.tenant_id
    AND e.workspace_id=NEW.workspace_id AND e.business_id=NEW.business_id
    AND e.event_type='completed' AND e.new_status='completed';
  IF NOT FOUND OR v_event.occurred_at IS DISTINCT FROM NEW.completed_at
     OR v_event.correlation_id IS DISTINCT FROM NEW.correlation_id THEN
    RAISE EXCEPTION 'sale effect: verified completion event required' USING ERRCODE='check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM business_operations.pos_catalog_line_origins a
     WHERE a.order_line_id=NEW.order_line_id AND a.order_id=NEW.order_id
       AND a.tenant_id=NEW.tenant_id AND a.workspace_id=NEW.workspace_id
       AND a.business_id=NEW.business_id AND a.catalog_product_id=NEW.catalog_product_id
       AND a.created_at <= NEW.completed_at
  ) THEN
    RAISE EXCEPTION 'sale effect: authenticated catalogue-line origin required' USING ERRCODE='check_violation';
  END IF;
  SELECT m.catalog_product_id,m.inventory_item_id,m.warehouse_id,
    m.inventory_unit_of_measure,m.unit_conversion_factor,m.state INTO v_mapping
  FROM business_operations.pos_inventory_mappings m
  WHERE m.id=NEW.mapping_id AND m.tenant_id=NEW.tenant_id
    AND m.workspace_id=NEW.workspace_id AND m.business_id=NEW.business_id;
  IF NOT FOUND OR v_mapping.state<>'active'
     OR v_mapping.catalog_product_id IS DISTINCT FROM NEW.catalog_product_id
     OR v_mapping.inventory_item_id IS DISTINCT FROM NEW.inventory_item_id
     OR v_mapping.warehouse_id IS DISTINCT FROM NEW.warehouse_id
     OR v_mapping.inventory_unit_of_measure IS DISTINCT FROM NEW.inventory_unit_of_measure
     OR v_mapping.unit_conversion_factor IS DISTINCT FROM NEW.unit_conversion_factor THEN
    RAISE EXCEPTION 'sale effect: active mapping snapshot mismatch' USING ERRCODE='check_violation';
  END IF;
  SELECT EXISTS(SELECT 1 FROM platform.inventory_items i WHERE i.id=NEW.inventory_item_id
    AND i.tenant_id=NEW.tenant_id AND i.workspace_id=NEW.workspace_id
    AND i.business_id=NEW.business_id AND i.status='active'
    AND i.unit_of_measure=NEW.inventory_unit_of_measure) INTO v_item_ok;
  SELECT EXISTS(SELECT 1 FROM platform.warehouses w WHERE w.id=NEW.warehouse_id
    AND w.tenant_id=NEW.tenant_id AND w.workspace_id=NEW.workspace_id
    AND w.business_id=NEW.business_id AND w.status='active') INTO v_warehouse_ok;
  IF NOT v_item_ok OR NOT v_warehouse_ok THEN
    RAISE EXCEPTION 'sale effect: active same-business stock target required' USING ERRCODE='check_violation';
  END IF;
  IF NEW.effect_quantity IS DISTINCT FROM NEW.sale_line_quantity*NEW.unit_conversion_factor THEN
    RAISE EXCEPTION 'sale effect: exact quantity mismatch' USING ERRCODE='check_violation';
  END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END $$;

INSERT INTO _migrations (filename) VALUES ('0231_pos_trusted_catalog_line_origins.sql')
  ON CONFLICT (filename) DO NOTHING;
COMMIT;
