-- Migration: 0206_order_payments_append_only_and_consistency
-- Two database guards for business_operations.order_payments (0203).
--
-- 1. Append-only: UPDATE, DELETE and TRUNCATE are rejected, using the repository convention business_operations.forbid_mutation()
--    (re-declared identically to 0182/0184, so delete-tenant-data.mjs keeps discovering append-only tables by that function name).
--    A correction is a NEW compensating record in a later block (refunds), never an edit.
--
-- 2. Consistency at COMMIT (DEFERRABLE INITIALLY DEFERRED constraint trigger, AFTER INSERT): for the order a payment points at,
--      - the order is 'completed',
--      - the payment's currency equals the order's currency,
--      - the payment's register session equals the order's register session,
--      - SUM(amount_applied) over all of the order's payments equals the order total exactly.
--    So a payment cannot exist for an open or voided order, in another currency or register, and an order can never be over- or
--    under-paid by any code path (a second payment added later makes the sum exceed the total and is refused).
--
-- Idempotent: DROP TRIGGER IF EXISTS before each CREATE. No GRANT/ROLE statements.

BEGIN;

CREATE OR REPLACE FUNCTION business_operations.forbid_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'business_operations.%: append-only table - % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

DROP TRIGGER IF EXISTS forbid_mutation_order_payments ON business_operations.order_payments;
CREATE TRIGGER forbid_mutation_order_payments
  BEFORE UPDATE OR DELETE ON business_operations.order_payments
  FOR EACH ROW EXECUTE FUNCTION business_operations.forbid_mutation();

DROP TRIGGER IF EXISTS forbid_truncate_order_payments ON business_operations.order_payments;
CREATE TRIGGER forbid_truncate_order_payments
  BEFORE TRUNCATE ON business_operations.order_payments
  FOR EACH STATEMENT EXECUTE FUNCTION business_operations.forbid_mutation();

CREATE OR REPLACE FUNCTION business_operations.check_order_payment_consistency()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  o RECORD;
  applied numeric(18,4);
BEGIN
  SELECT operational_status, currency_code, register_session_id, total_amount
    INTO o FROM platform.orders WHERE id = NEW.order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order_payments: order % not found', NEW.order_id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF o.operational_status <> 'completed' THEN
    RAISE EXCEPTION 'order_payments: order % is %, payments exist only for completed orders', NEW.order_id, o.operational_status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF o.currency_code <> NEW.currency_code THEN
    RAISE EXCEPTION 'order_payments: payment currency % differs from order currency %', NEW.currency_code, o.currency_code
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF o.register_session_id IS DISTINCT FROM NEW.register_session_id THEN
    RAISE EXCEPTION 'order_payments: payment register session differs from the order''s' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT COALESCE(SUM(amount_applied), 0) INTO applied FROM business_operations.order_payments WHERE order_id = NEW.order_id;
  IF applied <> o.total_amount THEN
    RAISE EXCEPTION 'order_payments: applied payments % do not equal the order total %', applied, o.total_amount
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS order_payments_consistency ON business_operations.order_payments;
CREATE CONSTRAINT TRIGGER order_payments_consistency
  AFTER INSERT ON business_operations.order_payments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION business_operations.check_order_payment_consistency();

INSERT INTO _migrations (filename) VALUES ('0206_order_payments_append_only_and_consistency.sql')
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
