#!/usr/bin/env bash
# BUILD-23 — Grants the least-privilege application role usage/CRUD
# access to every actively-used schema in a freshly migrated database.
#
# Migrations deliberately contain no GRANT statements anywhere in this
# repository (role provisioning is environment-specific, not part of
# the versioned schema — see every migration file's own absence of
# GRANT). Throughout this project's development this grant step was
# applied by hand, live, against one long-lived local database — never
# a problem until an automated pipeline (this build's CI workflow) needs
# a *fresh*, ephemeral database on every run. This script is that
# missing, now-scripted, idempotent step.
#
# Deliberately excludes the `public` schema: it holds only vestigial
# tables from the very first scaffolding migration (0001_foundation.sql)
# — _migrations plus a handful of superseded duplicates
# (public.tenants/users/businesses/etc.) that every real domain has its
# own properly namespaced replacement for (tenancy.tenants,
# identity.users, platform.businesses, ...). The application role has
# never had — and should not have — access to public schema; granting
# it broadly would silently re-expose _migrations, which every prior
# build's own testing (see backup.sh's requirements) established as
# deliberately off-limits to the app role.
#
# Usage:
#   ADMIN_DATABASE_URL="postgresql://<admin-role>:<pw>@<host>:5432/<db>" \
#   APP_ROLE="app_test_user" \
#     ./grant-app-role.sh

set -euo pipefail

if [[ -z "${ADMIN_DATABASE_URL:-}" ]]; then
  echo "ERROR: ADMIN_DATABASE_URL is required" >&2
  exit 1
fi
APP_ROLE="${APP_ROLE:-app_test_user}"

# F1 / F3 database-authority hardening (migration 0196): the application role may READ the governed tables but must not write the protected data
# directly. Rows are appended / reorder fields are changed only through the SECURITY DEFINER entry points
# (business_operations.record_execution_capability_activation, business_operations.apply_inventory_reorder_policy). The table triggers refuse a
# direct write from any role that is not the function owner even when these privileges are present (defence in depth), so this step is the
# least-privilege layer on top. Runs AFTER the blanket grants above and is idempotent; a no-op when the tables do not exist yet.
psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -v role="$APP_ROLE" <<'SQL'
BEGIN;
SET LOCAL hardening.role = :'role';
DO $grants$
DECLARE
  schema_name text;
  app_role text := current_setting('hardening.role');
  count_schemas integer := 0;
BEGIN
  FOR schema_name IN
    SELECT s.schema_name FROM information_schema.schemata s
    WHERE s.schema_name NOT IN ('pg_catalog','information_schema','pg_toast','public')
      AND s.schema_name NOT LIKE 'pg_temp%' AND s.schema_name NOT LIKE 'pg_toast_temp%'
    ORDER BY s.schema_name
  LOOP
    count_schemas := count_schemas + 1;
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', schema_name, app_role);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO %I', schema_name, app_role);
    EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA %I TO %I', schema_name, app_role);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', schema_name, app_role);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT EXECUTE ON FUNCTIONS TO %I', schema_name, app_role);
  END LOOP;
  IF count_schemas = 0 THEN
    RAISE EXCEPTION 'no schemas found — has the database been migrated yet?';
  END IF;
  -- Existing BO tables receive their explicit grants above. Future BO tables
  -- must be read-only until this script is rerun and protected-table rules apply.
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA business_operations REVOKE INSERT, UPDATE, DELETE ON TABLES FROM %I', app_role);
END
$grants$;
DO $hardening$
DECLARE
  protected_cols text[] := ARRAY['reorder_point','reorder_quantity','reorder_policy_state','reorder_policy_configured_at','reorder_policy_configured_source'];
  writable text;
  app_role text := current_setting('hardening.role');
BEGIN
  IF to_regclass('business_operations.execution_capability_activations') IS NOT NULL THEN
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON business_operations.execution_capability_activations FROM %I', app_role);
  END IF;
  IF to_regclass('business_operations.inventory_balances') IS NOT NULL THEN
    SELECT string_agg(format('%I', column_name), ', ' ORDER BY ordinal_position) INTO writable
      FROM information_schema.columns
     WHERE table_schema = 'business_operations' AND table_name = 'inventory_balances' AND column_name <> ALL (protected_cols);
    EXECUTE format('REVOKE UPDATE ON business_operations.inventory_balances FROM %I', app_role);
    EXECUTE format('GRANT UPDATE (%s) ON business_operations.inventory_balances TO %I', writable, app_role);
  END IF;
  -- V-18: platform.data_deletion_events is the platform-scoped right-to-erasure audit trail (migration 0149). It deliberately has no tenant column
  -- semantics (a tenant is gone once erased), so row-level security cannot isolate it; the blanket grant above would let ANY tenant session read other
  -- tenants' erasure records or rewrite and delete the trail. It is written only by infrastructure/database/scripts/delete-tenant-data.mjs through the
  -- ADMIN connection and read by no application code, so the application role gets no privilege on it at all (service-only access).
  IF to_regclass('platform.data_deletion_events') IS NOT NULL THEN
    EXECUTE format('REVOKE ALL PRIVILEGES ON platform.data_deletion_events FROM %I', app_role);
  END IF;
  -- OM-24 authority records remain read-only to the application role under forced RLS.
  -- OM-MEASURE-5 assessments use a separately granted runner role; publication receipts have no writer.
  IF to_regclass('outcome_monitoring.governed_measurement_definitions') IS NOT NULL THEN
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON outcome_monitoring.governed_measurement_definitions FROM %I', app_role);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON outcome_monitoring.governed_outcome_verdicts FROM %I', app_role);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON outcome_monitoring.om24_publication_receipts FROM %I', app_role);
  END IF;
  -- M1-A6: disabled evidence is readable through BO scope checks, with no application writer.
  -- Revoke after every blanket/default grant application so rerunning this script cannot reopen writes.
  IF to_regclass('business_operations.offline_review_evidence') IS NOT NULL THEN
    EXECUTE format('REVOKE ALL PRIVILEGES ON business_operations.offline_review_evidence FROM %I', app_role);
    EXECUTE format('GRANT SELECT ON business_operations.offline_review_evidence TO %I', app_role);
  END IF;
END
$hardening$;
COMMIT;
SQL
echo "Granted application access and applied protected-table revocations atomically for ${APP_ROLE}."
