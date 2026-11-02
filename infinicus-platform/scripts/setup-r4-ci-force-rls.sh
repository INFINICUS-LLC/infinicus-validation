#!/usr/bin/env bash
# Development-only setup for the current GitHub Actions PostgreSQL service.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true && "${CI:-}" == true ]] || { echo 'CI-only setup refused outside GitHub Actions' >&2; exit 1; }
[[ $# == 1 && "$1" =~ ^[0-9a-f]{64}$ ]] || { echo 'Expected the current job PostgreSQL service container ID' >&2; exit 1; }
service_id="$1"
[[ "$(docker inspect --format '{{.Config.Image}}' "$service_id")" == postgres:16 ]] || { echo 'Unexpected service image' >&2; exit 1; }
[[ "$(docker inspect --format '{{.State.Running}}' "$service_id")" == true ]] || { echo 'Service is not running' >&2; exit 1; }
# No network connection, user-provided URL, or production migration entrypoint.
docker exec -i "$service_id" psql -X -v ON_ERROR_STOP=1 -U infinicus_ci_admin -d infinicus_ci <<'SQL'
BEGIN;
DO $$
BEGIN
  IF current_database() <> 'infinicus_ci' OR session_user <> 'infinicus_ci_admin' THEN
    RAISE EXCEPTION 'Unexpected CI database or setup role';
  END IF;
END $$;
ALTER TABLE business_operations.bo_publication_packages FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'business_operations.bo_publication_packages'::regclass AND relrowsecurity AND relforcerowsecurity) THEN
    RAISE EXCEPTION 'CI header FORCE RLS setup failed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_test_user' AND NOT rolsuper AND NOT rolbypassrls)
     OR pg_has_role('app_test_user', (SELECT relowner FROM pg_class WHERE oid = 'business_operations.bo_publication_packages'::regclass), 'MEMBER') THEN
    RAISE EXCEPTION 'CI application role must be non-owner and non-bypass';
  END IF;
END $$;
COMMIT;
SQL
