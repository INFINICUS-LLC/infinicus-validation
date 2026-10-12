-- Migration: 0196_harden_database_authority_activation_and_reorder
-- Closes final-audit findings F1 and F3 (docs/architecture/reconciliation/FINAL_AUDIT_EXECUTION_PATH.md): make the DATABASE the hard
-- enforcement boundary for the two writes the locked architecture reserves, instead of an application convention.
--
--   F1  execution_capability_activations   may only be appended through  business_operations.record_execution_capability_activation(...)
--   F3  inventory_balances reorder fields  may only be written  through  business_operations.apply_inventory_reorder_policy(...)
--
-- MECHANISM (no role statements, no GRANT - this repository provisions roles per environment, see grant-app-role.sh):
--   * Each governed entry point is a SECURITY DEFINER function with an explicit, hardened search_path (pg_catalog, pg_temp); every object it names is
--     schema-qualified; it uses no dynamic SQL.
--   * The table trigger refuses the write unless BOTH (a) the function's transaction-local marker is set AND (b) current_user is the OWNER of that
--     function. Inside a SECURITY DEFINER function current_user is the function owner; in a plain session it is the connected role. A caller can set a
--     session variable, but it cannot become the function owner, so setting the old variable (or this marker) is no longer sufficient.
--     Consequence: the protection holds whenever the application connects as a role other than the migration/function owner (the CI model, and the
--     deployment precondition recorded in the audit follow-up).
--   * Belt and braces: grant-app-role.sh now also withholds the table privileges from the application role (INSERT/UPDATE/DELETE on the activation table;
--     UPDATE on the five protected reorder columns). That is environment provisioning, not schema, so it cannot live here.
--
-- The functions are the protected mutation boundary, NOT the authorization engine: the BO engine still performs claim validation, the final ABA
-- authority check, the capability gate, expiry/window/preconditions and the baseline comparison before it calls the reorder function. The activation
-- function additionally verifies, in the database, the actor's ACTIVE membership and a role granting the existing `bo:admin` permission (the same
-- rule the API enforces), and writes the audit row in the same transaction.
--
-- RLS: both functions run with the owner's rights, which may bypass RLS (a superuser or BYPASSRLS owner), so each re-establishes tenant isolation itself:
-- the p_tenant_id / p_workspace_id arguments must equal the transaction's authoritative app.tenant_id / app.workspace_id (what RLS keys on), the business
-- (and for reorder the balance) must belong to that exact tenant/workspace/business, and rows are selected by those keys. Caller-supplied ids cannot
-- override the authoritative scope.
--
-- DEPLOYMENT NOTE: because EXECUTE is revoked from PUBLIC, the application role must hold EXECUTE on the two governed functions. grant-app-role.sh grants
-- EXECUTE on all functions of the schema, so re-running it after this migration (as for every new function) is required before the application uses them.
--
-- NO backfill, NO rewrite, NO activation row created, NO default state. Existing rows and the NOT VALID reorder CHECK are untouched. Semantics of
-- activation (no row = CLOSED; append-only version chain; no-op on an unchanged state) and of the reorder write (compare-and-set, no rounding,
-- NO_CHANGE = no UPDATE and no version bump) are exactly those of the application code that this replaces. Idempotent. No GRANT or role statements.

BEGIN;

-- ---------------------------------------------------------------------------------------------------------------------------------------
-- F1  governed activation entry point
-- ---------------------------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION business_operations.record_execution_capability_activation(
  p_tenant_id uuid, p_workspace_id uuid, p_business_id uuid,
  p_action_type_code text, p_action_type_schema_version text, p_state text,
  p_actor_user_id uuid, p_permission_code text, p_reason text, p_correlation_id uuid
)
RETURNS TABLE (out_activation_id uuid, out_changed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant    uuid := nullif(pg_catalog.current_setting('app.tenant_id', true), '')::uuid;
  v_workspace uuid := nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid;
  v_latest_id uuid;
  v_latest_version integer;
  v_latest_state text;
  v_id uuid;
  v_reason text := pg_catalog.btrim(p_reason);
BEGIN
  IF p_tenant_id IS NULL OR p_workspace_id IS NULL OR p_business_id IS NULL OR p_actor_user_id IS NULL OR p_correlation_id IS NULL
     OR p_action_type_code IS NULL OR p_action_type_schema_version IS NULL OR p_state IS NULL OR p_permission_code IS NULL OR v_reason IS NULL THEN
    RAISE EXCEPTION 'record_execution_capability_activation: every argument is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Authoritative scope: the arguments may not name a scope other than the one this transaction runs in (what row-level security keys on).
  IF v_tenant IS DISTINCT FROM p_tenant_id OR v_workspace IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'record_execution_capability_activation: the stated tenant and workspace are not the transaction scope' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_permission_code IS DISTINCT FROM 'bo:admin' THEN
    RAISE EXCEPTION 'record_execution_capability_activation: activation is governed by bo:admin' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_state NOT IN ('ENABLED', 'DISABLED') THEN
    RAISE EXCEPTION 'record_execution_capability_activation: state must be ENABLED or DISABLED' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF pg_catalog.length(v_reason) = 0 OR pg_catalog.length(v_reason) > 500 THEN
    RAISE EXCEPTION 'record_execution_capability_activation: a reason of 1 to 500 characters is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- The actor must hold the permission NOW: an active membership in this tenant and workspace with a role that grants bo:admin.
  IF NOT EXISTS (
    SELECT 1
      FROM tenancy.memberships m
      JOIN tenancy.membership_roles mr ON mr.membership_id = m.id
      JOIN tenancy.role_permissions rp ON rp.role_id = mr.role_id
      JOIN tenancy.permissions p ON p.id = rp.permission_id
     WHERE m.tenant_id = p_tenant_id AND m.workspace_id = p_workspace_id AND m.user_id = p_actor_user_id
       AND m.status = 'active' AND p.code = 'bo:admin'
  ) THEN
    RAISE EXCEPTION 'record_execution_capability_activation: the actor has no active membership holding bo:admin in this workspace' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM platform.businesses b WHERE b.id = p_business_id AND b.tenant_id = p_tenant_id AND b.workspace_id = p_workspace_id) THEN
    RAISE EXCEPTION 'execution_capability_activations: the business does not belong to the stated tenant and workspace' USING ERRCODE = 'check_violation';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('execution_capability_activations:' || p_business_id::text || ':' || p_action_type_code || '@' || p_action_type_schema_version, 0));
  SELECT a.id, a.version, a.state INTO v_latest_id, v_latest_version, v_latest_state
    FROM business_operations.execution_capability_activations a
   WHERE a.business_id = p_business_id AND a.action_type_code = p_action_type_code AND a.action_type_schema_version = p_action_type_schema_version
   ORDER BY a.version DESC LIMIT 1;
  IF v_latest_state IS NOT DISTINCT FROM p_state THEN
    RETURN QUERY SELECT v_latest_id, false; -- recording the state the business is already in changes nothing
    RETURN;
  END IF;

  PERFORM pg_catalog.set_config('app.bo_activation_writer', 'record_execution_capability_activation', true);
  INSERT INTO business_operations.execution_capability_activations
    (tenant_id, workspace_id, business_id, action_type_code, action_type_schema_version, version, state, actor_user_id, permission_code, reason)
  VALUES (p_tenant_id, p_workspace_id, p_business_id, p_action_type_code, p_action_type_schema_version, coalesce(v_latest_version, 0) + 1, p_state, p_actor_user_id, p_permission_code, v_reason)
  RETURNING id INTO v_id;
  PERFORM pg_catalog.set_config('app.bo_activation_writer', '', true);

  -- The platform audit row is part of the SAME governed write (one record, no second source of truth): the activation cannot exist without it.
  INSERT INTO audit.audit_events (tenant_id, workspace_id, business_id, actor_type, actor_id, action, entity_type, entity_id, metadata, correlation_id)
  VALUES (p_tenant_id, p_workspace_id, p_business_id, 'user', p_actor_user_id,
          CASE p_state WHEN 'ENABLED' THEN 'bo.execution_activation.enabled' ELSE 'bo.execution_activation.disabled' END,
          'execution_capability_activation', v_id,
          pg_catalog.jsonb_build_object('actionType', p_action_type_code || '@' || p_action_type_schema_version, 'version', coalesce(v_latest_version, 0) + 1,
                                        'state', p_state, 'permission', p_permission_code, 'reason', v_reason),
          p_correlation_id);
  RETURN QUERY SELECT v_id, true;
END
$$;

COMMENT ON FUNCTION business_operations.record_execution_capability_activation(uuid, uuid, uuid, text, text, text, uuid, text, text, uuid) IS
  'F1: the ONLY way to append an execution capability activation. SECURITY DEFINER, search_path pinned. Verifies scope = transaction scope, bo:admin, the actor''s active membership and role, the business; appends the version-chained row and its audit row atomically; a repeated state is a no-op. No row = CLOSED.';

-- EXECUTE is not left with PUBLIC: only the owner and roles explicitly granted EXECUTE by environment provisioning (grant-app-role.sh grants it on every
-- function in the schema to the application role) can call the governed entry point. The function's own checks (scope, permission, actor) still apply.
REVOKE ALL ON FUNCTION business_operations.record_execution_capability_activation(uuid, uuid, uuid, text, text, text, uuid, text, text, uuid) FROM PUBLIC;

-- The insert guard now requires the governed entry point: the function's marker AND the function owner as current_user.
CREATE OR REPLACE FUNCTION business_operations.guard_execution_capability_activation_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  latest integer;
BEGIN
  IF coalesce(pg_catalog.current_setting('app.bo_activation_writer', true), '') <> 'record_execution_capability_activation'
     OR current_user IS DISTINCT FROM (
       SELECT pg_catalog.pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc p
        WHERE p.oid = 'business_operations.record_execution_capability_activation(uuid,uuid,uuid,text,text,text,uuid,text,text,uuid)'::pg_catalog.regprocedure) THEN
    RAISE EXCEPTION 'business_operations.execution_capability_activations: rows can only be appended through record_execution_capability_activation()' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM platform.businesses b WHERE b.id = NEW.business_id AND b.tenant_id = NEW.tenant_id AND b.workspace_id = NEW.workspace_id) THEN
    RAISE EXCEPTION 'execution_capability_activations: the business does not belong to the stated tenant and workspace' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('execution_capability_activations:' || NEW.business_id::text || ':' || NEW.action_type_code || '@' || NEW.action_type_schema_version, 0));
  SELECT pg_catalog.max(version) INTO latest FROM business_operations.execution_capability_activations
   WHERE business_id = NEW.business_id AND action_type_code = NEW.action_type_code AND action_type_schema_version = NEW.action_type_schema_version;
  IF NEW.version IS DISTINCT FROM coalesce(latest, 0) + 1 THEN
    RAISE EXCEPTION 'execution_capability_activations: version % does not follow version %', NEW.version, coalesce(latest, 0) USING ERRCODE = 'check_violation';
  END IF;
  NEW.recorded_at := pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp());
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------------------------------------------------------------------
-- F3  governed reorder-policy write
-- ---------------------------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION business_operations.apply_inventory_reorder_policy(
  p_tenant_id uuid, p_workspace_id uuid, p_business_id uuid, p_balance_id uuid,
  p_reorder_point numeric, p_reorder_quantity numeric, p_source text,
  p_expected_reorder_point numeric, p_expected_reorder_quantity numeric
)
RETURNS TABLE (out_applied boolean, out_reorder_point numeric, out_reorder_quantity numeric, out_reorder_policy_state text, out_version integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant    uuid := nullif(pg_catalog.current_setting('app.tenant_id', true), '')::uuid;
  v_workspace uuid := nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid;
  v_row business_operations.inventory_balances%ROWTYPE;
BEGIN
  IF p_tenant_id IS NULL OR p_workspace_id IS NULL OR p_business_id IS NULL OR p_balance_id IS NULL
     OR p_reorder_point IS NULL OR p_reorder_quantity IS NULL OR p_source IS NULL
     OR p_expected_reorder_point IS NULL OR p_expected_reorder_quantity IS NULL THEN
    RAISE EXCEPTION 'apply_inventory_reorder_policy: every argument is required (the expected baseline is mandatory)' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_tenant IS DISTINCT FROM p_tenant_id OR v_workspace IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'apply_inventory_reorder_policy: the stated tenant and workspace are not the transaction scope' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_source NOT IN ('BO_COMMAND', 'AUTHORIZED_ACTION_PACKAGE') THEN
    RAISE EXCEPTION 'apply_inventory_reorder_policy: source must be BO_COMMAND or AUTHORIZED_ACTION_PACKAGE' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Values are stored exactly: non-negative, at most 4 decimal places, inside numeric(18,4). Nothing is rounded.
  IF p_reorder_point < 0 OR p_reorder_quantity < 0 THEN
    RAISE EXCEPTION 'apply_inventory_reorder_policy: reorder values must not be negative' USING ERRCODE = 'check_violation';
  END IF;
  IF pg_catalog.scale(p_reorder_point) > 4 OR pg_catalog.scale(p_reorder_quantity) > 4 THEN
    RAISE EXCEPTION 'apply_inventory_reorder_policy: reorder values must have at most 4 decimal places (never rounded)' USING ERRCODE = 'numeric_value_out_of_range';
  END IF;
  IF p_reorder_point >= 100000000000000 OR p_reorder_quantity >= 100000000000000 THEN
    RAISE EXCEPTION 'apply_inventory_reorder_policy: reorder value exceeds the storable range' USING ERRCODE = 'numeric_value_out_of_range';
  END IF;

  SELECT * INTO v_row FROM business_operations.inventory_balances b
   WHERE b.id = p_balance_id AND b.tenant_id = p_tenant_id AND b.workspace_id = p_workspace_id AND b.business_id = p_business_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'apply_inventory_reorder_policy: no such balance in this tenant, workspace and business' USING ERRCODE = 'no_data_found';
  END IF;

  -- Compare-and-set: the caller read the balance under its own lock; if it is no longer what the caller judged, nothing is written (no rows).
  IF v_row.reorder_point IS DISTINCT FROM p_expected_reorder_point OR v_row.reorder_quantity IS DISTINCT FROM p_expected_reorder_quantity THEN
    RETURN;
  END IF;

  -- Re-sending the values a CONFIGURED balance already holds is a no-op: no UPDATE, no version bump.
  IF v_row.reorder_policy_state = 'CONFIGURED' AND v_row.reorder_point = p_reorder_point AND v_row.reorder_quantity = p_reorder_quantity THEN
    RETURN QUERY SELECT false, v_row.reorder_point, v_row.reorder_quantity, v_row.reorder_policy_state, v_row.version;
    RETURN;
  END IF;

  PERFORM pg_catalog.set_config('app.bo_reorder_policy_writer', 'apply_inventory_reorder_policy', true);
  UPDATE business_operations.inventory_balances b
     SET reorder_point = p_reorder_point, reorder_quantity = p_reorder_quantity, reorder_policy_state = 'CONFIGURED',
         reorder_policy_configured_at = pg_catalog.now(), reorder_policy_configured_source = p_source, version = b.version + 1
   WHERE b.id = v_row.id
  RETURNING b.* INTO v_row;
  PERFORM pg_catalog.set_config('app.bo_reorder_policy_writer', '', true);
  RETURN QUERY SELECT true, v_row.reorder_point, v_row.reorder_quantity, v_row.reorder_policy_state, v_row.version;
END
$$;

COMMENT ON FUNCTION business_operations.apply_inventory_reorder_policy(uuid, uuid, uuid, uuid, numeric, numeric, text, numeric, numeric) IS
  'F3: the ONLY way to write reorder_point / reorder_quantity / reorder_policy_* of an inventory balance. SECURITY DEFINER, search_path pinned. Verifies scope = transaction scope, the balance in tenant/workspace/business, exact non-negative 4-decimal values, the expected baseline (compare-and-set), and writes once under the row lock; an unchanged configured policy is a no-op. Authorization (claim, authority, gate, window, preconditions) stays in the BO engine.';

REVOKE ALL ON FUNCTION business_operations.apply_inventory_reorder_policy(uuid, uuid, uuid, uuid, numeric, numeric, text, numeric, numeric) FROM PUBLIC;

-- The reorder guard no longer trusts a session variable alone: it needs the governed function's marker AND the function owner as current_user.
CREATE OR REPLACE FUNCTION business_operations.enforce_reorder_policy_state_writer()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  is_writer boolean :=
    coalesce(pg_catalog.current_setting('app.bo_reorder_policy_writer', true), '') = 'apply_inventory_reorder_policy'
    AND current_user IS NOT DISTINCT FROM (
      SELECT pg_catalog.pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc p
       WHERE p.oid = 'business_operations.apply_inventory_reorder_policy(uuid,uuid,uuid,uuid,numeric,numeric,text,numeric,numeric)'::pg_catalog.regprocedure);
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.reorder_policy_state <> 'UNSET' AND NOT is_writer THEN
      RAISE EXCEPTION 'business_operations.inventory_balances: reorder policy can only be configured through apply_inventory_reorder_policy()'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.reorder_policy_state = 'CONFIGURED' AND NEW.reorder_policy_state <> 'CONFIGURED' THEN
    RAISE EXCEPTION 'business_operations.inventory_balances: a configured reorder policy cannot return to UNSET'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF NOT is_writer AND (
       NEW.reorder_policy_state IS DISTINCT FROM OLD.reorder_policy_state
    OR NEW.reorder_policy_configured_at IS DISTINCT FROM OLD.reorder_policy_configured_at
    OR NEW.reorder_policy_configured_source IS DISTINCT FROM OLD.reorder_policy_configured_source
    OR NEW.reorder_point IS DISTINCT FROM OLD.reorder_point
    OR NEW.reorder_quantity IS DISTINCT FROM OLD.reorder_quantity
  ) THEN
    RAISE EXCEPTION 'business_operations.inventory_balances: reorder policy can only be configured through apply_inventory_reorder_policy()'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION business_operations.enforce_reorder_policy_state_writer() IS
  'F3: reorder_point / reorder_quantity / reorder_policy_* change only inside business_operations.apply_inventory_reorder_policy() - its transaction-local marker AND current_user = the function owner (a session variable alone is not sufficient); CONFIGURED never returns to UNSET.';

INSERT INTO _migrations (filename) VALUES ('0196_harden_database_authority_activation_and_reorder.sql')
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
