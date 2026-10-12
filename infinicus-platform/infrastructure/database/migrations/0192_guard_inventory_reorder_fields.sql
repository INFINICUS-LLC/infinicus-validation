-- Migration: 0192_guard_inventory_reorder_fields
-- P0-6c (owner ruling O-11: approve the M3 reorder-field database write guard).
--
-- Makes "the only writer of reorder_point / reorder_quantity after a balance exists is the Business Operations configure command" a DATABASE
-- fact rather than a convention. Migration 0189 already guarded the reorder values of a CONFIGURED balance; this extends the same guard to
-- ANY update of the two fields (an UNSET balance included), using the same transaction-local marker that only the BO command sets
-- (`app.bo_reorder_policy_writer` = 'configure_inventory_reorder_policy'; the authorized-action execution path calls that same command).
-- INSERT is unchanged: a balance is still created with its (default 0/0) values by the movement path.
--
-- Also adds `reorder_point >= 0 AND reorder_quantity >= 0` as a CHECK ... NOT VALID: new and updated rows are validated, rows that already
-- exist are NOT scanned, rewritten or repaired (no backfill; the constraint is never VALIDATEd here).
--
-- Convention-level limitation, stated plainly: the marker is a transaction-local setting that any session able to run SET LOCAL could set,
-- so this is a guard against accidental or unauthorized application writes, not a privilege boundary. Idempotent. No GRANT/role statements.

BEGIN;

CREATE OR REPLACE FUNCTION business_operations.enforce_reorder_policy_state_writer()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  is_writer boolean := coalesce(current_setting('app.bo_reorder_policy_writer', true), '') = 'configure_inventory_reorder_policy';
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.reorder_policy_state <> 'UNSET' AND NOT is_writer THEN
      RAISE EXCEPTION 'business_operations.inventory_balances: reorder policy can only be configured by the configure_inventory_reorder_policy command'
        USING ERRCODE = 'raise_exception';
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
    RAISE EXCEPTION 'business_operations.inventory_balances: reorder policy can only be configured by the configure_inventory_reorder_policy command'
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION business_operations.enforce_reorder_policy_state_writer() IS
  'Data-capture Block E + P0-6c M3: only the BO configure_inventory_reorder_policy command (transaction-local app.bo_reorder_policy_writer) may configure the reorder policy or change reorder_point / reorder_quantity after the balance exists; CONFIGURED never returns to UNSET.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_balances_reorder_non_negative'
                  AND conrelid = 'business_operations.inventory_balances'::regclass) THEN
    ALTER TABLE business_operations.inventory_balances
      ADD CONSTRAINT inventory_balances_reorder_non_negative
      CHECK (reorder_point >= 0 AND reorder_quantity >= 0) NOT VALID;
  END IF;
END
$$;

INSERT INTO _migrations (filename) VALUES ('0192_guard_inventory_reorder_fields.sql')
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
