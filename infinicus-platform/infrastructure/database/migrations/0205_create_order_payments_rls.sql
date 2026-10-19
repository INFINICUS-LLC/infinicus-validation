-- Migration: 0205_create_order_payments_rls
-- Row Level Security for business_operations.order_payments (0203). Same tenant + workspace predicate as every other business_operations
-- table (null-safe, fail-closed; see 0167). FORCE ROW LEVEL SECURITY from the start (compare 0186), so even the table owner is held to the
-- policy; superusers and BYPASSRLS roles keep their privilege as everywhere else.

BEGIN;

ALTER TABLE business_operations.order_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_operations.order_payments FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS order_payments_isolation ON business_operations.order_payments;
CREATE POLICY order_payments_isolation ON business_operations.order_payments
  USING (
    tenant_id        = current_setting('app.tenant_id',    true)::uuid
    AND workspace_id = current_setting('app.workspace_id', true)::uuid
  );

INSERT INTO _migrations (filename) VALUES ('0205_create_order_payments_rls.sql')
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
