-- Migration: 0204_create_order_payments_indexes
-- Indexes for business_operations.order_payments (0203): the per-order lookup (loading an order with its payments) and the per-session
-- tender totals (register summary and cash reconciliation).

BEGIN;

CREATE INDEX IF NOT EXISTS idx_order_payments_order   ON business_operations.order_payments (order_id);
CREATE INDEX IF NOT EXISTS idx_order_payments_session ON business_operations.order_payments (register_session_id, method);

INSERT INTO _migrations (filename) VALUES ('0204_create_order_payments_indexes.sql')
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
