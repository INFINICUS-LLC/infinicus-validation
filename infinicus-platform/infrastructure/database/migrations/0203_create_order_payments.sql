-- Migration: 0203_create_order_payments
-- POS-5 (tender capture). Additive. One row per payment taken against an order; written ONLY inside the transaction that completes the order.
--
-- Money model (one row):
--   amount_tendered  what the customer handed over (> 0)
--   amount_applied   the part counted against the order (> 0, <= tendered)
--   change_given     tendered - applied; non-zero only for cash
--   position         1, 2, ... the order in which the payments were entered (unique per order)
-- The sum of amount_applied over an order's payments must equal the order total; the deferred consistency trigger in 0206 enforces that
-- (and that the order is completed, in the same currency and in the same register session) at COMMIT.
--
-- `reference` is an optional slip/receipt number, at most 64 characters. It must never hold a card number, so a run of 13 or more digits
-- (spaces and hyphens allowed between them) is refused by the database as well as by the application. No card data is processed or stored.
--
-- Also adds UNIQUE (id, business_id) on platform.orders so the payment row can point at its order with a same-business composite key.
-- The register-session composite key relies on UNIQUE (id, business_id) added to register_sessions by 0202.
--
-- RLS (0205), indexes (0204) and the append-only / consistency triggers (0206) follow in their own files. Idempotent. No GRANT/ROLE
-- statements (role provisioning is environment-specific, see grant-app-role.sh). Not applied live.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'platform.orders'::regclass AND conname = 'orders_id_business_unique'
  ) THEN
    ALTER TABLE platform.orders ADD CONSTRAINT orders_id_business_unique UNIQUE (id, business_id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS business_operations.order_payments (
  id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid          NOT NULL REFERENCES tenancy.tenants(id)     ON DELETE RESTRICT,
  workspace_id        uuid          NOT NULL REFERENCES tenancy.workspaces(id)  ON DELETE RESTRICT,
  business_id         uuid          NOT NULL REFERENCES platform.businesses(id) ON DELETE RESTRICT,
  order_id            uuid          NOT NULL,
  register_session_id uuid          NOT NULL,
  position            integer       NOT NULL CHECK (position >= 1),
  method              text          NOT NULL CHECK (method IN ('cash','card','other')),
  currency_code       text          NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  amount_tendered     numeric(18,4) NOT NULL CHECK (amount_tendered > 0),
  amount_applied      numeric(18,4) NOT NULL CHECK (amount_applied > 0),
  change_given        numeric(18,4) NOT NULL,
  reference           text,
  created_by          uuid          REFERENCES identity.users(id) ON DELETE RESTRICT,
  created_at          timestamptz   NOT NULL DEFAULT now(),
  correlation_id      uuid          NOT NULL DEFAULT gen_random_uuid(),
  CONSTRAINT order_payments_order_same_business_fk
    FOREIGN KEY (order_id, business_id) REFERENCES platform.orders (id, business_id) ON DELETE RESTRICT,
  CONSTRAINT order_payments_session_same_business_fk
    FOREIGN KEY (register_session_id, business_id) REFERENCES business_operations.register_sessions (id, business_id) ON DELETE RESTRICT,
  CONSTRAINT order_payments_position_unique UNIQUE (order_id, position),
  CONSTRAINT order_payments_applied_within_tendered CHECK (amount_applied <= amount_tendered),
  CONSTRAINT order_payments_change_is_the_difference CHECK (change_given = amount_tendered - amount_applied),
  CONSTRAINT order_payments_change_only_for_cash CHECK (method = 'cash' OR change_given = 0),
  CONSTRAINT order_payments_reference_shape CHECK (
    reference IS NULL OR (char_length(reference) BETWEEN 1 AND 64 AND reference !~ '([0-9][ -]?){13,}')
  )
);

COMMENT ON TABLE business_operations.order_payments IS
  'Append-only tender ledger (POS-5). Rows are written only when an order is completed; a mistake is never edited.';

INSERT INTO _migrations (filename) VALUES ('0203_create_order_payments.sql')
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
