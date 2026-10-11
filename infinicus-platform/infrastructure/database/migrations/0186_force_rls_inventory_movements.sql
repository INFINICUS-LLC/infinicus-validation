-- Migration: 0186_force_rls_inventory_movements
-- Defence in depth - business_operations.inventory_movements gets FORCE ROW LEVEL SECURITY.
--
-- 0035 enabled RLS on the table with the policy `inventory_movements_isolation` (tenant + workspace). RLS was ENABLED but not FORCED, so the
-- table OWNER (a non-superuser, non-BYPASSRLS owner) would have bypassed the policy. The runtime application role is not the owner, is not a
-- superuser and does not have BYPASSRLS, so RLS already applies to it and its behaviour is unchanged. FORCE closes the owner path.
--
-- Scope: exactly one statement. The policy predicate, the 0184 append-only triggers, the 0183 cost/currency constraints, columns, indexes,
-- grants and every writer are untouched. Superusers and BYPASSRLS roles keep their privilege (PostgreSQL never applies RLS to them); the
-- repository's test-only cleanup runs as a superuser and is unaffected. No data is read, moved, rewritten or backfilled.
--
-- Idempotent: FORCE ROW LEVEL SECURITY on an already-forced table is a no-op. No GRANT or role statements (role provisioning is
-- environment-specific, see grant-app-role.sh).

BEGIN;

ALTER TABLE business_operations.inventory_movements FORCE ROW LEVEL SECURITY;

INSERT INTO _migrations (filename) VALUES ('0186_force_rls_inventory_movements.sql')
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
