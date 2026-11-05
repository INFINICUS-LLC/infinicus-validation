-- SEC-BILL-02B-1 (SF-3): harden the three legacy BUILD-28 billing event-emission functions (defined in migration 0153). DEVELOPMENT CANDIDATE.
-- Forward-only: no table, column, trigger, policy or previously merged migration changes; the three functions keep their names, argument lists, return type and the
-- row they write. Only these three functions change. Wider SECURITY DEFINER hardening in other schemas is a separately authorized block.
--
-- Finding (reproduced on main 095a32e1, disposable PostgreSQL 16): the functions were SECURITY DEFINER with no pinned search_path and PUBLIC EXECUTE, and they trusted their
-- tenant arguments. A tenant-A application session could therefore write a pending events.outbox_events row in tenant B's name (the same INSERT done directly is refused by
-- row-level security), and the helper accepted ANY event type, including the control-loop execution events the event worker dispatches.
--
-- Corrections:
--  * SET search_path = pg_catalog, pg_temp, with every relation and function schema-qualified (pg_catalog.now(), pg_catalog.gen_random_uuid(), events.outbox_events, ...).
--  * Trusted tenant identity: the tenant and workspace arguments must equal the session's own app.tenant_id / app.workspace_id, the settings every RLS policy of the platform trusts
--    (set from the authenticated request context by withTenantTransaction, never by a client). Anything else, a missing context or a malformed one is refused (SQLSTATE 42501 / 22P02).
--    All three repository call sites already pass the transaction's own ctx.tenantId / ctx.workspaceId, so legitimate calls are unchanged.
--  * The helper writes billing.* events only (billing.<name>[.<name>...], lowercase): it can no longer mint another domain's event, such as control_loop.action.authorized.
--  * EXECUTE is revoked from PUBLIC. The internal helper is also withheld from the application role by infrastructure/database/scripts/grant-app-role.sh (its only callers are
--    the two wrappers, which run as the function owner); the two wrappers stay executable by the application role because the billing repositories call them.
-- Rollback (development only): re-apply the definitions of migration 0153.
BEGIN;

CREATE OR REPLACE FUNCTION billing.emit_outbox_event(
  p_tenant_id       uuid,
  p_workspace_id    uuid,
  p_event_type      text,
  p_event_version   text,
  p_correlation_id  uuid,
  p_causation_id    uuid,
  p_payload         jsonb,
  p_aggregate_type  text DEFAULT NULL,
  p_aggregate_id    uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_event_id uuid;
BEGIN
  IF p_tenant_id IS NULL OR p_workspace_id IS NULL
     OR p_tenant_id IS DISTINCT FROM NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid
     OR p_workspace_id IS DISTINCT FROM NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid THEN
    RAISE EXCEPTION 'billing.emit_outbox_event: tenant scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_event_type IS NULL OR p_event_type !~ '^billing(\.[a-z][a-z_]*)+$' THEN
    RAISE EXCEPTION 'billing.emit_outbox_event: event type not permitted' USING ERRCODE = '42501';
  END IF;
  INSERT INTO events.outbox_events (
    id, tenant_id, workspace_id, event_type, event_version,
    payload, correlation_id, causation_id,
    aggregate_type, aggregate_id, status, created_at
  ) VALUES (
    pg_catalog.gen_random_uuid(), p_tenant_id, p_workspace_id, p_event_type, p_event_version,
    p_payload, p_correlation_id, p_causation_id,
    p_aggregate_type, p_aggregate_id, 'pending', pg_catalog.now()
  ) RETURNING id INTO v_event_id;
  RETURN v_event_id;
END;
$$;

CREATE OR REPLACE FUNCTION billing.emit_subscription_status_changed(
  p_tenant_id uuid, p_workspace_id uuid, p_subscription_id uuid,
  p_from_status text, p_to_status text, p_correlation_id uuid
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RETURN billing.emit_outbox_event(
    p_tenant_id, p_workspace_id, 'billing.subscription.status_changed', '1.0', p_correlation_id, NULL,
    pg_catalog.jsonb_build_object('subscriptionId', p_subscription_id, 'fromStatus', p_from_status, 'toStatus', p_to_status),
    'subscription', p_subscription_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION billing.emit_usage_limit_exceeded(
  p_tenant_id uuid, p_workspace_id uuid, p_metric text, p_limit_value bigint, p_attempted_quantity bigint,
  p_correlation_id uuid
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RETURN billing.emit_outbox_event(
    p_tenant_id, p_workspace_id, 'billing.usage.limit_exceeded', '1.0', p_correlation_id, NULL,
    pg_catalog.jsonb_build_object('metric', p_metric, 'limitValue', p_limit_value, 'attemptedQuantity', p_attempted_quantity),
    'usage_record', pg_catalog.gen_random_uuid()
  );
END;
$$;

REVOKE ALL ON FUNCTION billing.emit_outbox_event(uuid, uuid, text, text, uuid, uuid, jsonb, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION billing.emit_subscription_status_changed(uuid, uuid, uuid, text, text, uuid)     FROM PUBLIC;
REVOKE ALL ON FUNCTION billing.emit_usage_limit_exceeded(uuid, uuid, text, bigint, bigint, uuid)        FROM PUBLIC;

INSERT INTO _migrations (filename) VALUES ('0227_harden_billing_emit_functions.sql') ON CONFLICT (filename) DO NOTHING;

COMMIT;
