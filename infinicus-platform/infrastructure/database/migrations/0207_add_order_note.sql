-- Migration: 0207_add_order_note
-- POS-6c (order note). Additive only; no data is rewritten and nothing is backfilled.
--
-- platform.orders.note: nullable text, the cashier's free-text note on an order ("table 4", "no sugar", "pick up at 6"). NULL = no note.
--   - 1 to 500 characters when present (the application stores an empty note as NULL);
--   - never a card number: a run of 13 or more digits (spaces and hyphens allowed between them) is refused by the database as well as by the
--     application, exactly like a payment reference (0203). No card data is processed or stored anywhere.
-- The note is set through the API only while the order is open; once the order is completed or voided it is read-only. It is an INTERNAL note: it is not
-- printed on the customer receipt.
--
-- RLS and triggers on platform.orders are unchanged (the new column sits under the existing tenant/workspace policies). Idempotent. No GRANT/ROLE
-- statements. Rolling the application code back leaves this column unused and harmless. Not applied live.

BEGIN;

ALTER TABLE platform.orders
  ADD COLUMN IF NOT EXISTS note text;

COMMENT ON COLUMN platform.orders.note IS
  'Internal cashier note (1-500 characters, never a card number); NULL = none. Editable only while the order is open (0207).';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'platform.orders'::regclass AND conname = 'orders_note_format'
  ) THEN
    ALTER TABLE platform.orders
      ADD CONSTRAINT orders_note_format
      CHECK (note IS NULL OR (char_length(note) BETWEEN 1 AND 500 AND note !~ '([0-9][ -]?){13,}'));
  END IF;
END $$;

INSERT INTO _migrations (filename) VALUES ('0207_add_order_note.sql')
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
