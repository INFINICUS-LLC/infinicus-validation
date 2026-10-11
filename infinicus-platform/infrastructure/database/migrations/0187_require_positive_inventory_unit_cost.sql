-- Migration: 0187_require_positive_inventory_unit_cost
-- Data-capture Block B (owner-authorised): a movement's unit cost stays OPTIONAL, but when it is present it must be a positive amount.
--
-- Evidence invariant after Block B, together with 0183 (cost and currency travel together):
--   no cost:      unit_cost IS NULL      and unit_cost_currency IS NULL
--   cost present: unit_cost > 0          and unit_cost_currency present and valid
--
-- The CHECK is added NOT VALID. In PostgreSQL a NOT VALID check constraint is still ENFORCED for every new row (INSERT) and every
-- updated row (UPDATE); NOT VALID only skips re-validating rows that already exist. That is deliberate: rows written before this migration
-- may carry a zero or negative cost (live Supabase has not applied 0183+ and was never inspected), and history is neither validated,
-- rewritten, repaired nor backfilled here. A historical non-positive cost remains historical and is treated by the B2 COST evaluator as
-- INDETERMINATE. The constraint is never VALIDATEd by this migration.
--
-- PostgreSQL numeric orders NaN ABOVE every number, so `unit_cost > 0` alone would ACCEPT 'NaN'; the check therefore also excludes NaN
-- explicitly (numeric(18,4) already rejects Infinity).
--
-- unit_cost is numeric(18,4): a positive value smaller than 0.0001 is rounded to 0.0000 by PostgreSQL before the CHECK runs, so the
-- database refuses it as well (the application layers refuse it earlier, explicitly, instead of rounding it).
--
-- Idempotent: the constraint is created only if it does not exist. No GRANT or role statements. No data is read, changed or deleted.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'inventory_movements_unit_cost_positive'
       AND conrelid = 'business_operations.inventory_movements'::regclass
  ) THEN
    ALTER TABLE business_operations.inventory_movements
      ADD CONSTRAINT inventory_movements_unit_cost_positive
      CHECK (unit_cost IS NULL OR (unit_cost > 0 AND unit_cost <> 'NaN'::numeric)) NOT VALID;
  END IF;
END
$$;

INSERT INTO _migrations (filename) VALUES ('0187_require_positive_inventory_unit_cost.sql')
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
