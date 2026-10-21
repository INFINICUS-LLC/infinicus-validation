-- Migration: 0210_create_offline_sales
-- OFF-1 (server offline sale processing), step 2: the schema only. Design: docs/implementation-queue/DESIGN-OFF-1-SERVER-OFFLINE-SALE-PROCESSING.md (section 4.3).
-- Number 0210: the POS-9 decision record reserved 0210 for per-product kitchen routing and 0211+ for OFF-1 (section 6, "reservations on paper"), but the repository
-- guard migration-stage2a requires migration numbers with NO gaps, so OFF-1 takes the next free number, 0210, by owner decision (2026-10-21). Kitchen routing takes the
-- next free number when it is written. The runner applies any unapplied file in file-name order.
--
-- Additive only: one new table, one new nullable column, one new function. Nothing existing is rewritten and nothing is backfilled.
--
-- platform.orders.client_sale_id: the offline sale (device-generated UUID) an order was created for; NULL for every online order. A PARTIAL UNIQUE index
--   (business_id, client_sale_id) makes a second order for the same offline sale impossible, even if the offline_sales row were lost.
--
-- business_operations.offline_sales: an APPEND-ONLY record of every offline sale the server has processed, one row per client_sale_id per business, written in
--   the same transaction as the order (when there is one). It records what the DEVICE claimed and what the SERVER computed, and never hides a difference.
--   - outcome        'accepted' | 'accepted_with_difference' | 'needs_review'. needs_review creates NO order (order_id IS NULL) and carries a fixed review_reason code;
--                    the two accepted outcomes carry the order and no review_reason. (Resolving a needs_review row is OFF-4 and will be a NEW append-only row.)
--   - claimed_register_session_id  what the device said (no foreign key, so an unknown or foreign session can still be recorded as an exception);
--     register_session_id          the verified session of THIS business (composite foreign key), set only when the server verified it.
--   - *_minor        integer minor units of currency_code (KWD 3, USD 2, JPY 0), never floating point. device_total_minor is what the device showed;
--                    server_total_minor is what the server computed (NULL when it could not, e.g. a product no longer exists); difference_minor = server - device.
--   - request_digest sha-256 of the canonical request, so a replay with a different body under the same client_sale_id is detectable.
--   - lines_detail   jsonb array with, per line, the device's claim and the server's result. NO CARD DATA, no customer data, no note text is stored.
-- Append-only like order_payments (0206) and print_jobs (0209): UPDATE, DELETE and TRUNCATE are refused by the existing
-- business_operations.forbid_mutation(). Tenant isolation: ENABLE and FORCE row-level security with the same fail-closed tenant + workspace policy (0205).
--
-- business_operations.check_offline_sale_consistency(): BEFORE INSERT guard. When a row names an order, that order must be a completed order of the same
--   business whose client_sale_id, register session and currency equal the row's. The money invariant itself (payments sum to the order total) stays with the
--   order_payments trigger (0206), which is not touched.
--
-- ROLLBACK (safe while no offline sale has been accepted, which is the case until offline selling is enabled; afterwards take a backup first):
--   DROP TABLE business_operations.offline_sales;
--   DROP FUNCTION business_operations.check_offline_sale_consistency();
--   DROP INDEX platform.orders_business_client_sale_unique;
--   ALTER TABLE platform.orders DROP COLUMN client_sale_id;
--   DELETE FROM _migrations WHERE filename = '0210_create_offline_sales.sql';   -- only if the ledger entry must be removed
--
-- No CHECK uses BETWEEN inside an AND (that shape is re-parsed flat by a dump and restore, see restore-proof.sh restored_fingerprint); the device_id length
-- check is written as a flat AND list on purpose.
--
-- Idempotent. No GRANT/ROLE statements (the application role is granted by grant-app-role.sh). Not applied live.

BEGIN;

ALTER TABLE platform.orders
  ADD COLUMN IF NOT EXISTS client_sale_id uuid;

COMMENT ON COLUMN platform.orders.client_sale_id IS
  'The device-generated identity (UUID) of the offline sale this order was created for (OFF-1, 0210); NULL = an online order. Unique per business when set.';

CREATE UNIQUE INDEX IF NOT EXISTS orders_business_client_sale_unique
  ON platform.orders (business_id, client_sale_id)
  WHERE client_sale_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS business_operations.offline_sales (
  id                          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   uuid        NOT NULL REFERENCES tenancy.tenants(id)     ON DELETE RESTRICT,
  workspace_id                uuid        NOT NULL REFERENCES tenancy.workspaces(id)  ON DELETE RESTRICT,
  business_id                 uuid        NOT NULL REFERENCES platform.businesses(id) ON DELETE RESTRICT,
  client_sale_id              uuid        NOT NULL,
  device_id                   text        NOT NULL CHECK (char_length(device_id) >= 1 AND char_length(device_id) <= 64 AND device_id ~ '^[A-Za-z0-9._:-]+$'),
  claimed_register_session_id uuid        NOT NULL,
  register_session_id         uuid,
  order_id                    uuid,
  outcome                     text        NOT NULL CHECK (outcome IN ('accepted','accepted_with_difference','needs_review')),
  review_reason               text        CHECK (review_reason IN (
                                            'session_not_found','session_closed','session_currency_mismatch','product_unavailable',
                                            'price_drift_not_allowed','underpaid','invariant_failed','other')),
  currency_code               text        NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  device_created_at           timestamptz NOT NULL,
  received_at                 timestamptz NOT NULL DEFAULT now(),
  clock_skew_seconds          integer     NOT NULL,
  catalogue_snapshot_at       timestamptz NOT NULL,
  device_total_minor          bigint      NOT NULL CHECK (device_total_minor >= 0),
  server_total_minor          bigint      CHECK (server_total_minor >= 0),
  difference_minor            bigint,
  request_digest              text        NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  lines_detail                jsonb       NOT NULL CHECK (jsonb_typeof(lines_detail) = 'array'),
  created_by                  uuid        REFERENCES identity.users(id) ON DELETE RESTRICT,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  correlation_id              uuid        NOT NULL DEFAULT gen_random_uuid(),
  CONSTRAINT offline_sales_business_client_sale_unique UNIQUE (business_id, client_sale_id),
  CONSTRAINT offline_sales_session_same_business_fk
    FOREIGN KEY (register_session_id, business_id) REFERENCES business_operations.register_sessions (id, business_id) ON DELETE RESTRICT,
  CONSTRAINT offline_sales_order_same_business_fk
    FOREIGN KEY (order_id, business_id) REFERENCES platform.orders (id, business_id) ON DELETE RESTRICT,
  CONSTRAINT offline_sales_review_reason_iff_review CHECK ((outcome = 'needs_review') = (review_reason IS NOT NULL)),
  CONSTRAINT offline_sales_order_iff_accepted CHECK ((outcome = 'needs_review') = (order_id IS NULL)),
  CONSTRAINT offline_sales_accepted_has_verified_session CHECK (outcome = 'needs_review' OR register_session_id IS NOT NULL),
  CONSTRAINT offline_sales_difference_is_server_minus_device CHECK (
    (server_total_minor IS NULL AND difference_minor IS NULL)
    OR (server_total_minor IS NOT NULL AND difference_minor IS NOT NULL AND difference_minor = server_total_minor - device_total_minor)),
  CONSTRAINT offline_sales_accepted_has_server_total CHECK (outcome = 'needs_review' OR server_total_minor IS NOT NULL),
  CONSTRAINT offline_sales_exact_accept_has_no_difference CHECK (outcome <> 'accepted' OR difference_minor = 0)
);

COMMENT ON TABLE business_operations.offline_sales IS
  'Append-only record of every offline sale the server processed (OFF-1, 0210): the device''s claim, the server''s result and any difference. A needs_review row creates no order.';

CREATE INDEX IF NOT EXISTS idx_offline_sales_tenant    ON business_operations.offline_sales (tenant_id);
CREATE INDEX IF NOT EXISTS idx_offline_sales_workspace ON business_operations.offline_sales (workspace_id);
CREATE INDEX IF NOT EXISTS idx_offline_sales_business  ON business_operations.offline_sales (business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_offline_sales_review    ON business_operations.offline_sales (business_id, created_at DESC) WHERE outcome = 'needs_review';
CREATE INDEX IF NOT EXISTS idx_offline_sales_order     ON business_operations.offline_sales (order_id) WHERE order_id IS NOT NULL;

CREATE OR REPLACE FUNCTION business_operations.check_offline_sale_consistency()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  o RECORD;
BEGIN
  IF NEW.order_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT business_id, operational_status, client_sale_id, register_session_id, currency_code
    INTO o FROM platform.orders WHERE id = NEW.order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'offline_sales: order % not found', NEW.order_id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF o.operational_status <> 'completed' THEN
    RAISE EXCEPTION 'offline_sales: order % is %, an accepted offline sale needs a completed order', NEW.order_id, o.operational_status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF o.client_sale_id IS DISTINCT FROM NEW.client_sale_id THEN
    RAISE EXCEPTION 'offline_sales: order % was not created for client_sale_id %', NEW.order_id, NEW.client_sale_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF o.register_session_id IS DISTINCT FROM NEW.register_session_id THEN
    RAISE EXCEPTION 'offline_sales: the order''s register session differs from the sale''s' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF o.currency_code <> NEW.currency_code THEN
    RAISE EXCEPTION 'offline_sales: sale currency % differs from order currency %', NEW.currency_code, o.currency_code
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE business_operations.offline_sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_operations.offline_sales FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'business_operations' AND tablename = 'offline_sales' AND policyname = 'offline_sales_isolation') THEN
    CREATE POLICY offline_sales_isolation ON business_operations.offline_sales
      USING (
        tenant_id        = current_setting('app.tenant_id',    true)::uuid
        AND workspace_id = current_setting('app.workspace_id', true)::uuid
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'business_operations.offline_sales'::regclass AND tgname = 'forbid_mutation_offline_sales') THEN
    CREATE TRIGGER forbid_mutation_offline_sales
      BEFORE UPDATE OR DELETE ON business_operations.offline_sales
      FOR EACH ROW EXECUTE FUNCTION business_operations.forbid_mutation();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'business_operations.offline_sales'::regclass AND tgname = 'forbid_truncate_offline_sales') THEN
    CREATE TRIGGER forbid_truncate_offline_sales
      BEFORE TRUNCATE ON business_operations.offline_sales
      FOR EACH STATEMENT EXECUTE FUNCTION business_operations.forbid_mutation();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'business_operations.offline_sales'::regclass AND tgname = 'check_offline_sale_consistency_trg') THEN
    CREATE TRIGGER check_offline_sale_consistency_trg
      BEFORE INSERT ON business_operations.offline_sales
      FOR EACH ROW EXECUTE FUNCTION business_operations.check_offline_sale_consistency();
  END IF;
END $$;

INSERT INTO _migrations (filename) VALUES ('0210_create_offline_sales.sql')
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
