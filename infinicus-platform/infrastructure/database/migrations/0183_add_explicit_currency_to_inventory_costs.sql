-- Migration: 0183_add_explicit_currency_to_inventory_costs
-- Data-capture Block C (owner-authorised): the currency of a cost-bearing inventory movement becomes explicit.
--
-- Defect: business_operations.inventory_movements.unit_cost carried no currency, so a cost could not be safely compared with a declared
-- business currency or a currency-denominated cap. This migration adds ONLY the explicit-currency evidence. It does not make a cost
-- mandatory (a receipt may carry no cost), does not validate the cost value (unit_cost > 0 is Block B), and adds no receipt, linkage or
-- reorder-state structure (Blocks A, D, E).
--
-- 1. inventory_movements.unit_cost_currency: nullable text, ISO 4217-style three uppercase letters (the platform convention already used
--    for currency codes, see 0179). NULLABLE and NEVER BACKFILLED: every historical row keeps a NULL currency and therefore stays
--    currency-unproven. No currency is inferred from any default.
-- 2. Presence invariant, enforced for NEW and UPDATED rows only (NOT VALID): unit_cost and unit_cost_currency are both present or both
--    absent. A cost without a currency, or a currency without a cost, is refused. Historical rows with a cost and no currency are not
--    validated and not touched; VALIDATE CONSTRAINT is deliberately not run. (The movement table remains append-only by convention; this
--    migration adds no UPDATE path and does not change that.)
-- 3. purchase_orders.currency_code loses its silent DEFAULT 'USD'. The column stays NOT NULL, so a new purchase order must now state its
--    currency; existing rows are untouched (a stored 'USD' is not evidence of a deliberate choice and is not rewritten).
--
-- RLS, indexes, triggers and all other columns are unchanged. Idempotent. No GRANT/ROLE statements. Not applied live.

BEGIN;

ALTER TABLE business_operations.inventory_movements
  ADD COLUMN IF NOT EXISTS unit_cost_currency text;

COMMENT ON COLUMN business_operations.inventory_movements.unit_cost_currency IS
  'ISO 4217-style code of unit_cost. Explicit only: never defaulted, never backfilled. NULL on a row with a cost means the currency is unproven (historical data).';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'business_operations.inventory_movements'::regclass AND conname = 'inventory_movements_unit_cost_currency_format'
  ) THEN
    ALTER TABLE business_operations.inventory_movements
      ADD CONSTRAINT inventory_movements_unit_cost_currency_format
      CHECK (unit_cost_currency IS NULL OR unit_cost_currency ~ '^[A-Z]{3}$');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'business_operations.inventory_movements'::regclass AND conname = 'inventory_movements_unit_cost_currency_presence'
  ) THEN
    ALTER TABLE business_operations.inventory_movements
      ADD CONSTRAINT inventory_movements_unit_cost_currency_presence
      CHECK ((unit_cost IS NULL) = (unit_cost_currency IS NULL)) NOT VALID;
  END IF;
END $$;

ALTER TABLE business_operations.purchase_orders
  ALTER COLUMN currency_code DROP DEFAULT;

INSERT INTO _migrations (filename) VALUES ('0183_add_explicit_currency_to_inventory_costs.sql')
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
