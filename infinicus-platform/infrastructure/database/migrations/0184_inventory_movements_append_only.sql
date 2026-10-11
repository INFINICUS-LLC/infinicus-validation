-- Migration: 0184_inventory_movements_append_only
-- Data-capture follow-up - business_operations.inventory_movements becomes append-only at the database level.
--
-- 0027 documented the table as an "append-only stock change ledger" but enforced it only by convention. Movement rows (quantity,
-- movement_type, unit_cost, unit_cost_currency, occurred_at) are Business Operations evidence that later governance evaluation
-- (B2 COST / EXPECTED_OUTCOME) reads; they must not be alterable after insertion by any role.
--
-- Scope: UPDATE, DELETE and TRUNCATE are rejected unconditionally. INSERT, columns, constraints (including the 0183 cost/currency
-- constraints), RLS policy, indexes and every reader are unchanged. No data is moved, rewritten, repaired or backfilled; existing
-- rows stay exactly as they are. A correction to history is a NEW compensating movement, never an edit.
--
-- The function name `forbid_mutation` deliberately matches the repository convention (0049 ... 0181, 0182) that
-- delete-tenant-data.mjs uses to discover append-only tables, so a tenant erasure retains these rows and reports them instead of
-- aborting. business_operations.forbid_mutation() is created by 0182; it is re-declared here identically so this migration is
-- self-contained and idempotent (CREATE OR REPLACE with the same body).
--
-- Foreign keys from this table are all ON DELETE RESTRICT except performed_by (ON DELETE SET NULL): deleting an employee who is
-- referenced by a movement now fails, because the referential SET NULL is itself an UPDATE. This is intended (the actor on a
-- movement is evidence) and is recorded in the block report.
--
-- Idempotent: DROP TRIGGER IF EXISTS before each CREATE TRIGGER. No GRANT or role statements (role provisioning is
-- environment-specific, see grant-app-role.sh). RLS is not changed.

BEGIN;

CREATE OR REPLACE FUNCTION business_operations.forbid_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'business_operations.%: append-only table - % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

DROP TRIGGER IF EXISTS forbid_mutation_inventory_movements ON business_operations.inventory_movements;
CREATE TRIGGER forbid_mutation_inventory_movements
  BEFORE UPDATE OR DELETE ON business_operations.inventory_movements
  FOR EACH ROW EXECUTE FUNCTION business_operations.forbid_mutation();

DROP TRIGGER IF EXISTS forbid_truncate_inventory_movements ON business_operations.inventory_movements;
CREATE TRIGGER forbid_truncate_inventory_movements
  BEFORE TRUNCATE ON business_operations.inventory_movements
  FOR EACH STATEMENT EXECUTE FUNCTION business_operations.forbid_mutation();

INSERT INTO _migrations (filename) VALUES ('0184_inventory_movements_append_only.sql')
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
