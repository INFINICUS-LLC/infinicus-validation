-- POS2-04-S2: BO-owned mapping configuration only. No sale-effect consumer or stock writer.
BEGIN;

CREATE TABLE business_operations.pos_inventory_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenancy.tenants(id) ON DELETE RESTRICT,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspaces(id) ON DELETE RESTRICT,
  business_id uuid NOT NULL REFERENCES platform.businesses(id) ON DELETE RESTRICT,
  catalog_product_id uuid NOT NULL REFERENCES business_operations.products(id) ON DELETE RESTRICT,
  inventory_item_id uuid NOT NULL REFERENCES platform.inventory_items(id) ON DELETE RESTRICT,
  warehouse_id uuid NOT NULL REFERENCES platform.warehouses(id) ON DELETE RESTRICT,
  -- Unconstrained NUMERIC keeps the equality check exact; numeric(18,4) would round 1.00001 to 1 before CHECK.
  unit_conversion_factor numeric NOT NULL DEFAULT 1 CHECK (unit_conversion_factor = 1),
  inventory_unit_of_measure text NOT NULL,
  state text NOT NULL CHECK (state IN ('active', 'inactive')),
  created_by uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deactivated_at timestamptz,
  CONSTRAINT pos_inventory_mapping_state_time CHECK ((state = 'active' AND deactivated_at IS NULL) OR (state = 'inactive' AND deactivated_at IS NOT NULL)),
  CONSTRAINT pos_inventory_mapping_scoped_id UNIQUE (id, tenant_id, workspace_id, business_id)
);
-- Initial contract: one unambiguous active effect per catalogue product. Future recipes need a separate approval.
CREATE UNIQUE INDEX pos_inventory_mapping_one_active_product
  ON business_operations.pos_inventory_mappings (tenant_id, workspace_id, business_id, catalog_product_id)
  WHERE state = 'active';

CREATE TABLE business_operations.pos_inventory_mapping_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mapping_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  business_id uuid NOT NULL,
  transition text NOT NULL CHECK (transition IN ('created', 'deactivated')),
  actor_user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  correlation_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT pos_inventory_mapping_history_scope FOREIGN KEY (mapping_id, tenant_id, workspace_id, business_id)
    REFERENCES business_operations.pos_inventory_mappings (id, tenant_id, workspace_id, business_id) ON DELETE RESTRICT,
  CONSTRAINT pos_inventory_mapping_history_once UNIQUE (mapping_id, transition)
);

ALTER TABLE business_operations.pos_inventory_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_operations.pos_inventory_mappings FORCE ROW LEVEL SECURITY;
CREATE POLICY pos_inventory_mapping_scope ON business_operations.pos_inventory_mappings
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
ALTER TABLE business_operations.pos_inventory_mapping_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_operations.pos_inventory_mapping_history FORCE ROW LEVEL SECURITY;
CREATE POLICY pos_inventory_mapping_history_scope ON business_operations.pos_inventory_mapping_history
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

CREATE FUNCTION business_operations.guard_pos_inventory_mapping() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_uom text;
BEGIN
  IF current_user <> (SELECT pg_get_userbyid(p.proowner) FROM pg_proc p WHERE p.oid = 'business_operations.configure_pos_inventory_mapping(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid)'::regprocedure)
     OR current_setting('app.pos_mapping_writer', true) IS DISTINCT FROM 'configure' THEN
    RAISE EXCEPTION 'pos inventory mapping: governed writer required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.state <> 'active' OR NEW.state <> 'inactive' OR NEW.deactivated_at IS NULL
       OR (to_jsonb(NEW) - 'state' - 'deactivated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'state' - 'deactivated_at') THEN
      RAISE EXCEPTION 'pos inventory mapping: only governed deactivation is allowed' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM business_operations.products p WHERE p.id = NEW.catalog_product_id AND p.tenant_id = NEW.tenant_id AND p.workspace_id = NEW.workspace_id AND p.business_id = NEW.business_id AND p.active) THEN
    RAISE EXCEPTION 'pos inventory mapping: catalogue product scope or state invalid' USING ERRCODE = 'check_violation';
  END IF;
  SELECT i.unit_of_measure INTO v_uom FROM platform.inventory_items i
   WHERE i.id = NEW.inventory_item_id AND i.tenant_id = NEW.tenant_id AND i.workspace_id = NEW.workspace_id AND i.business_id = NEW.business_id AND i.status = 'active';
  IF v_uom IS NULL OR v_uom IS DISTINCT FROM NEW.inventory_unit_of_measure THEN
    RAISE EXCEPTION 'pos inventory mapping: inventory item scope, state or unit invalid' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM platform.warehouses w WHERE w.id = NEW.warehouse_id AND w.tenant_id = NEW.tenant_id AND w.workspace_id = NEW.workspace_id AND w.business_id = NEW.business_id AND w.status = 'active') THEN
    RAISE EXCEPTION 'pos inventory mapping: warehouse scope or state invalid' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_pos_inventory_mapping BEFORE INSERT OR UPDATE ON business_operations.pos_inventory_mappings
  FOR EACH ROW EXECUTE FUNCTION business_operations.guard_pos_inventory_mapping();

CREATE FUNCTION business_operations.refuse_pos_inventory_mapping_delete() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  RAISE EXCEPTION 'pos inventory mapping: append-only deletion refused' USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER refuse_pos_inventory_mapping_delete BEFORE DELETE ON business_operations.pos_inventory_mappings
  FOR EACH ROW EXECUTE FUNCTION business_operations.refuse_pos_inventory_mapping_delete();
CREATE TRIGGER refuse_pos_inventory_mapping_truncate BEFORE TRUNCATE ON business_operations.pos_inventory_mappings
  FOR EACH STATEMENT EXECUTE FUNCTION business_operations.refuse_pos_inventory_mapping_delete();

CREATE FUNCTION business_operations.guard_pos_inventory_mapping_history() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'pos inventory mapping history: append-only' USING ERRCODE = 'check_violation';
  END IF;
  IF current_user <> (SELECT pg_get_userbyid(p.proowner) FROM pg_proc p WHERE p.oid = 'business_operations.configure_pos_inventory_mapping(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid)'::regprocedure)
     OR current_setting('app.pos_mapping_writer', true) IS DISTINCT FROM 'configure' THEN
    RAISE EXCEPTION 'pos inventory mapping history: governed writer required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_pos_inventory_mapping_history BEFORE INSERT OR UPDATE OR DELETE ON business_operations.pos_inventory_mapping_history
  FOR EACH ROW EXECUTE FUNCTION business_operations.guard_pos_inventory_mapping_history();
CREATE TRIGGER refuse_pos_inventory_mapping_history_truncate BEFORE TRUNCATE ON business_operations.pos_inventory_mapping_history
  FOR EACH STATEMENT EXECUTE FUNCTION business_operations.refuse_pos_inventory_mapping_delete();

-- The application passes a principal established by canonical authentication; this function rechecks current membership and scope.
CREATE FUNCTION business_operations.configure_pos_inventory_mapping(
  p_tenant uuid, p_workspace uuid, p_business uuid, p_product uuid, p_item uuid, p_warehouse uuid,
  p_actor uuid, p_correlation uuid, p_deactivate_mapping uuid DEFAULT NULL
) RETURNS TABLE(mapping_id uuid, changed boolean) LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_existing business_operations.pos_inventory_mappings%ROWTYPE; v_id uuid; v_uom text;
BEGIN
  IF p_tenant IS NULL OR p_workspace IS NULL OR p_business IS NULL OR p_actor IS NULL OR p_correlation IS NULL OR p_product IS NULL THEN
    RAISE EXCEPTION 'pos inventory mapping: required identity missing' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF nullif(current_setting('app.tenant_id', true), '')::uuid IS DISTINCT FROM p_tenant
     OR nullif(current_setting('app.workspace_id', true), '')::uuid IS DISTINCT FROM p_workspace
     OR nullif(current_setting('app.user_id', true), '')::uuid IS DISTINCT FROM p_actor THEN
    RAISE EXCEPTION 'pos inventory mapping: transaction scope mismatch' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM platform.businesses b WHERE b.id = p_business AND b.tenant_id = p_tenant AND b.workspace_id = p_workspace) THEN
    RAISE EXCEPTION 'pos inventory mapping: business scope mismatch' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM tenancy.memberships m JOIN tenancy.membership_roles mr ON mr.membership_id = m.id
    JOIN tenancy.roles r ON r.id = mr.role_id
    JOIN tenancy.role_permissions rp ON rp.role_id = mr.role_id JOIN tenancy.permissions perm ON perm.id = rp.permission_id
    WHERE m.tenant_id = p_tenant AND m.workspace_id = p_workspace AND m.user_id = p_actor AND m.status = 'active'
      AND (r.tenant_id IS NULL OR r.tenant_id = p_tenant)
      AND (mr.business_id IS NULL OR mr.business_id = p_business) AND perm.code = 'bo:admin'
  ) THEN
    RAISE EXCEPTION 'pos inventory mapping: current bo:admin authority required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('pos_inventory_mapping:' || p_business::text || ':' || p_product::text, 0));
  SELECT * INTO v_existing FROM business_operations.pos_inventory_mappings m
   WHERE m.tenant_id = p_tenant AND m.workspace_id = p_workspace AND m.business_id = p_business AND m.catalog_product_id = p_product AND m.state = 'active';
  IF p_deactivate_mapping IS NOT NULL THEN
    IF v_existing.id IS DISTINCT FROM p_deactivate_mapping THEN
      RAISE EXCEPTION 'pos inventory mapping: active mapping mismatch' USING ERRCODE = 'check_violation';
    END IF;
    PERFORM set_config('app.pos_mapping_writer', 'configure', true);
    UPDATE business_operations.pos_inventory_mappings SET state = 'inactive', deactivated_at = clock_timestamp() WHERE id = v_existing.id;
    INSERT INTO business_operations.pos_inventory_mapping_history (mapping_id, tenant_id, workspace_id, business_id, transition, actor_user_id, correlation_id)
      VALUES (v_existing.id, p_tenant, p_workspace, p_business, 'deactivated', p_actor, p_correlation);
    PERFORM set_config('app.pos_mapping_writer', '', true);
    RETURN QUERY SELECT v_existing.id, true; RETURN;
  END IF;
  IF p_item IS NULL OR p_warehouse IS NULL THEN
    RAISE EXCEPTION 'pos inventory mapping: item and warehouse required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_existing.id IS NOT NULL THEN
    IF v_existing.inventory_item_id IS DISTINCT FROM p_item OR v_existing.warehouse_id IS DISTINCT FROM p_warehouse THEN
      RAISE EXCEPTION 'pos inventory mapping: conflicting active association' USING ERRCODE = 'unique_violation';
    END IF;
    RETURN QUERY SELECT v_existing.id, false; RETURN;
  END IF;
  SELECT i.unit_of_measure INTO v_uom FROM platform.inventory_items i
   WHERE i.id = p_item AND i.tenant_id = p_tenant AND i.workspace_id = p_workspace AND i.business_id = p_business AND i.status = 'active';
  IF v_uom IS NULL THEN RAISE EXCEPTION 'pos inventory mapping: invalid inventory item' USING ERRCODE = 'check_violation'; END IF;
  PERFORM set_config('app.pos_mapping_writer', 'configure', true);
  INSERT INTO business_operations.pos_inventory_mappings
    (tenant_id, workspace_id, business_id, catalog_product_id, inventory_item_id, warehouse_id, unit_conversion_factor, inventory_unit_of_measure, state, created_by)
  VALUES (p_tenant, p_workspace, p_business, p_product, p_item, p_warehouse, 1, v_uom, 'active', p_actor) RETURNING id INTO v_id;
  INSERT INTO business_operations.pos_inventory_mapping_history
    (mapping_id, tenant_id, workspace_id, business_id, transition, actor_user_id, correlation_id)
  VALUES (v_id, p_tenant, p_workspace, p_business, 'created', p_actor, p_correlation);
  PERFORM set_config('app.pos_mapping_writer', '', true);
  RETURN QUERY SELECT v_id, true;
END $$;
REVOKE ALL ON FUNCTION business_operations.configure_pos_inventory_mapping(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid) FROM PUBLIC;

INSERT INTO _migrations (filename) VALUES ('0228_pos_inventory_mapping_foundation.sql') ON CONFLICT (filename) DO NOTHING;
COMMIT;
