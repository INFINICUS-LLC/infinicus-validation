-- Migration: 0199_create_list_active_memberships
-- NA-04 (web authentication and API foundation, owner decision NEW-ARCH-R0 / Option B): the web client must learn WHICH tenant/workspace the signed-in user
-- belongs to. tenancy.memberships is row-level-secured to ONE tenant+workspace at a time (0011), so a user's memberships across workspaces cannot be listed
-- by the application role without widening that policy. This adds ONE read-only, narrowly scoped entry point instead of any policy change.
--
--   tenancy.list_active_memberships(p_user_id uuid)
--     returns the ACTIVE memberships of exactly that user (not deleted): tenant id/name/status and workspace id/name/status. Nothing else: no roles,
--     no permissions, no emails, no other member's row.
--
-- MECHANISM (no role statements, no GRANT - this repository provisions roles per environment, see grant-app-role.sh; same pattern as 0196):
--   * SECURITY DEFINER with an explicit, hardened search_path (pg_catalog, pg_temp); every object it names is schema-qualified; no dynamic SQL.
--   * The function refuses unless p_user_id equals the transaction's authoritative app.user_id (set by the API from the VALIDATED session, never from the
--     request). A caller-supplied id that differs from the transaction's user raises; a missing app.user_id raises. So it cannot be used to list another
--     user's memberships even by an application bug that passes a wrong argument.
--   * It reads the tables as their owner (RLS on these three tables is ENABLE-only, so the owner is not subject to it; a superuser/BYPASSRLS owner is
--     not either). It re-establishes isolation itself by selecting strictly on user_id. If a future migration FORCEs RLS on these tables the function will
--     return no rows (fail closed); the integration test pins today's behaviour.
--   * Read-only: STABLE, no write, no audit row, no side effect.
--
-- DEPLOYMENT NOTE: EXECUTE is revoked from PUBLIC. The application role needs EXECUTE: grant-app-role.sh grants it on every function in the schema, so it
-- must be re-run after this migration (as for every new function). The API route that calls it MUST NOT be released before this migration is applied
-- (an unapplied function answers 500, never data). No live migration is performed by this change.
--
-- NO backfill, NO rewrite, NO policy change, NO table change. Idempotent.

BEGIN;

CREATE OR REPLACE FUNCTION tenancy.list_active_memberships(p_user_id uuid)
RETURNS TABLE (
  out_tenant_id uuid,
  out_tenant_name text,
  out_tenant_status text,
  out_workspace_id uuid,
  out_workspace_name text,
  out_workspace_status text,
  out_joined_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_user uuid := nullif(pg_catalog.current_setting('app.user_id', true), '')::uuid;
BEGIN
  IF p_user_id IS NULL OR v_user IS NULL OR p_user_id <> v_user THEN
    RAISE EXCEPTION 'list_active_memberships: user does not match the transaction user' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
    SELECT t.id, t.name, t.status, w.id, w.name, w.status, m.joined_at
      FROM tenancy.memberships m
      JOIN tenancy.workspaces w ON w.id = m.workspace_id AND w.tenant_id = m.tenant_id
      JOIN tenancy.tenants t ON t.id = m.tenant_id
     WHERE m.user_id = p_user_id
       AND m.status = 'active'
       AND w.deleted_at IS NULL
       AND t.deleted_at IS NULL
     ORDER BY t.name, w.name, w.id;
END;
$$;

COMMENT ON FUNCTION tenancy.list_active_memberships(uuid) IS
  'NA-04: the ONLY cross-workspace read of memberships. SECURITY DEFINER, search_path pinned. Returns the ACTIVE, non-deleted memberships of exactly p_user_id, and only when p_user_id equals the transaction''s authoritative app.user_id (otherwise 42501). Ids, names and statuses only; no roles, permissions or other users. Read-only. Not an authorization engine: every business route still resolves membership and permission per request.';

REVOKE ALL ON FUNCTION tenancy.list_active_memberships(uuid) FROM PUBLIC;

INSERT INTO _migrations (filename) VALUES ('0199_create_list_active_memberships.sql')
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
