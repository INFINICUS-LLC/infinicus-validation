-- Migration: 0189_add_inventory_reorder_policy_state
-- Data-capture Block E (owner ruling O-10; specification: DATA-CAPTURE_RECONCILIATION_inventory-cost-receipts.md section 3E).
--
-- Distinguishes a DELIBERATELY configured reorder policy from the system default. Before this migration `reorder_point = 0` could mean either
-- "never configured" (every system-created balance) or "deliberately zero"; the rule set could not tell them apart.
--
--   reorder_policy_state              UNSET (default) | CONFIGURED
--   reorder_policy_configured_at      database time of the last configuration (NULL while UNSET)
--   reorder_policy_configured_source  BO_COMMAND | AUTHORIZED_ACTION_PACKAGE (NULL while UNSET)
--
-- Ownership: only the Business Operations command `configure_inventory_reorder_policy` may move a balance to CONFIGURED or change a
-- configured balance's reorder values. The trigger below enforces that for every database role by requiring a transaction-local setting
-- (`app.bo_reorder_policy_writer`) that only that command sets. This is a CONVENTION-LEVEL guard, not a privilege boundary: any session
-- able to run SET LOCAL could set it, so the architecture tests additionally pin the single writer in code. ABA never writes the column.
--
-- NO BACKFILL: every existing row becomes UNSET through the column default, including rows whose reorder values are non-zero. Marking
-- historical values as configured needs an owner ruling (Q-D4) and is not done here. No existing row is read, rewritten or repaired.
--
-- A configured policy is never silently returned to UNSET. Idempotent: every object is created only if missing. No GRANT or role
-- statements.

BEGIN;

ALTER TABLE business_operations.inventory_balances
  ADD COLUMN IF NOT EXISTS reorder_policy_state text NOT NULL DEFAULT 'UNSET',
  ADD COLUMN IF NOT EXISTS reorder_policy_configured_at timestamptz,
  ADD COLUMN IF NOT EXISTS reorder_policy_configured_source text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_balances_reorder_policy_state_check'
                  AND conrelid = 'business_operations.inventory_balances'::regclass) THEN
    ALTER TABLE business_operations.inventory_balances
      ADD CONSTRAINT inventory_balances_reorder_policy_state_check
      CHECK (reorder_policy_state IN ('UNSET', 'CONFIGURED'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_balances_reorder_policy_source_check'
                  AND conrelid = 'business_operations.inventory_balances'::regclass) THEN
    ALTER TABLE business_operations.inventory_balances
      ADD CONSTRAINT inventory_balances_reorder_policy_source_check
      CHECK (reorder_policy_configured_source IS NULL
             OR reorder_policy_configured_source IN ('BO_COMMAND', 'AUTHORIZED_ACTION_PACKAGE'));
  END IF;
  -- UNSET <=> no configuration facts; CONFIGURED => time and source present.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_balances_reorder_policy_consistency_check'
                  AND conrelid = 'business_operations.inventory_balances'::regclass) THEN
    ALTER TABLE business_operations.inventory_balances
      ADD CONSTRAINT inventory_balances_reorder_policy_consistency_check
      CHECK ((reorder_policy_state = 'UNSET'
              AND reorder_policy_configured_at IS NULL AND reorder_policy_configured_source IS NULL)
          OR (reorder_policy_state = 'CONFIGURED'
              AND reorder_policy_configured_at IS NOT NULL AND reorder_policy_configured_source IS NOT NULL));
  END IF;
END
$$;

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
    OR (OLD.reorder_policy_state = 'CONFIGURED'
        AND (NEW.reorder_point IS DISTINCT FROM OLD.reorder_point OR NEW.reorder_quantity IS DISTINCT FROM OLD.reorder_quantity))
  ) THEN
    RAISE EXCEPTION 'business_operations.inventory_balances: reorder policy can only be configured by the configure_inventory_reorder_policy command'
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION business_operations.enforce_reorder_policy_state_writer() IS
  'Data-capture Block E: only the BO configure_inventory_reorder_policy command (transaction-local app.bo_reorder_policy_writer) may configure or change a configured reorder policy; CONFIGURED never returns to UNSET.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_inventory_balances_reorder_policy_writer'
                  AND tgrelid = 'business_operations.inventory_balances'::regclass) THEN
    CREATE TRIGGER trg_inventory_balances_reorder_policy_writer
      BEFORE INSERT OR UPDATE ON business_operations.inventory_balances
      FOR EACH ROW EXECUTE FUNCTION business_operations.enforce_reorder_policy_state_writer();
  END IF;
END
$$;

INSERT INTO _migrations (filename) VALUES ('0189_add_inventory_reorder_policy_state.sql')
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
