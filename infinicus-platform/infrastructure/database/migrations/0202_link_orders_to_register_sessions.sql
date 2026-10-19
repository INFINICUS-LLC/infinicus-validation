-- Migration: 0202_link_orders_to_register_sessions
-- POS-4 (register link). Additive only; no data is rewritten and nothing is backfilled.
--
-- 1. business_operations.register_sessions.currency_code: nullable text, three uppercase letters (the platform convention, see 0183).
--    The application sets it when a register is opened, from the business's declared currency (migration 0185); NULL means a session
--    opened before this migration, whose currency was never recorded. No currency is inferred or defaulted.
-- 2. business_operations.register_sessions UNIQUE (id, business_id): the target of the composite foreign key below, so an order can only
--    point at a register session of ITS OWN business (a session id from another business is refused by the database).
-- 3. platform.orders.register_session_id: nullable uuid. Existing orders stay NULL (they were taken before register linking existed).
--    The composite foreign key (register_session_id, business_id) -> register_sessions (id, business_id) uses MATCH SIMPLE, so a NULL link
--    is allowed and a non-NULL link must match the order's business. ON DELETE RESTRICT: a session with orders cannot be deleted.
-- 4. An index on the link for the per-session summary.
--
-- RLS, triggers and all other columns are unchanged (the new column sits under the existing tenant/workspace policies). Idempotent.
-- No GRANT/ROLE statements. Rolling the application code back leaves these objects unused and harmless. Not applied live.

BEGIN;

ALTER TABLE business_operations.register_sessions
  ADD COLUMN IF NOT EXISTS currency_code text;

COMMENT ON COLUMN business_operations.register_sessions.currency_code IS
  'ISO 4217-style code of the session''s cash, set from the business''s declared currency when the register is opened. NULL = opened before 0202 (currency not recorded).';

ALTER TABLE platform.orders
  ADD COLUMN IF NOT EXISTS register_session_id uuid;

COMMENT ON COLUMN platform.orders.register_session_id IS
  'The register session the order was taken in (same business). NULL = taken before register linking (0202).';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'business_operations.register_sessions'::regclass AND conname = 'register_sessions_currency_code_format'
  ) THEN
    ALTER TABLE business_operations.register_sessions
      ADD CONSTRAINT register_sessions_currency_code_format
      CHECK (currency_code IS NULL OR currency_code ~ '^[A-Z]{3}$');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'business_operations.register_sessions'::regclass AND conname = 'register_sessions_id_business_unique'
  ) THEN
    ALTER TABLE business_operations.register_sessions
      ADD CONSTRAINT register_sessions_id_business_unique UNIQUE (id, business_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'platform.orders'::regclass AND conname = 'orders_register_session_same_business_fk'
  ) THEN
    ALTER TABLE platform.orders
      ADD CONSTRAINT orders_register_session_same_business_fk
      FOREIGN KEY (register_session_id, business_id)
      REFERENCES business_operations.register_sessions (id, business_id)
      ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_orders_register_session
  ON platform.orders (register_session_id)
  WHERE register_session_id IS NOT NULL;

INSERT INTO _migrations (filename) VALUES ('0202_link_orders_to_register_sessions.sql')
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
