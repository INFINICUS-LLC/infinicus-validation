-- Migration: 0209_create_print_jobs
-- POS-8c (print-job log). Additive only: one new table, nothing existing is touched, nothing is backfilled.
--
-- business_operations.print_jobs: an APPEND-ONLY log of print attempts, one row per attempt, written after the attempt with its outcome.
--   - kind          'receipt' (customer receipt) | 'kitchen' (kitchen ticket);
--   - trigger_kind  'automatic' (printed by itself after the server confirmed the sale) | 'reprint' | 'manual' (for example "Send to kitchen");
--   - outcome       'succeeded' | 'failed'; a failure carries a short fixed failure_code (never free text), a success carries none;
--   - printed_via   'browser' | 'device' (the device shell, POS-8d);
--   - printer_id    the registry printer (0208) used, or NULL when the browser's own print path was used with no registry entry.
-- NO CONTENT IS STORED: no receipt lines, no customer data, no note text, no device address. Only who/what/when/how it ended.
-- Append-only like order_payments (0206): UPDATE, DELETE and TRUNCATE are refused by the existing business_operations.forbid_mutation() function
-- (no new function is created). Tenant isolation: the same fail-closed tenant + workspace policy as every business_operations table.
-- The application checks that the order and printer belong to the business before inserting (inside row-level security).
--
-- ROLLBACK (no data outside this table is affected):
--   DROP TABLE business_operations.print_jobs;
--   DELETE FROM _migrations WHERE filename = '0209_create_print_jobs.sql';   -- only if the ledger entry must be removed
--
-- Idempotent. No GRANT/ROLE statements. Not applied live.

BEGIN;

CREATE TABLE IF NOT EXISTS business_operations.print_jobs (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid        NOT NULL REFERENCES tenancy.tenants(id)     ON DELETE RESTRICT,
  workspace_id  uuid        NOT NULL REFERENCES tenancy.workspaces(id)  ON DELETE RESTRICT,
  business_id   uuid        NOT NULL REFERENCES platform.businesses(id) ON DELETE RESTRICT,
  order_id      uuid        NOT NULL REFERENCES platform.orders(id)     ON DELETE RESTRICT,
  printer_id    uuid                 REFERENCES business_operations.printers(id) ON DELETE RESTRICT,
  kind          text        NOT NULL CHECK (kind IN ('receipt','kitchen')),
  trigger_kind  text        NOT NULL CHECK (trigger_kind IN ('automatic','reprint','manual')),
  outcome       text        NOT NULL CHECK (outcome IN ('succeeded','failed')),
  failure_code  text        CHECK (failure_code IN ('printer_error','timeout','unsupported','other')),
  printed_via   text        NOT NULL CHECK (printed_via IN ('browser','device')),
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT print_jobs_failure_code_consistent CHECK ((outcome = 'failed') = (failure_code IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_print_jobs_tenant    ON business_operations.print_jobs (tenant_id);
CREATE INDEX IF NOT EXISTS idx_print_jobs_workspace ON business_operations.print_jobs (workspace_id);
CREATE INDEX IF NOT EXISTS idx_print_jobs_business  ON business_operations.print_jobs (business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_print_jobs_order     ON business_operations.print_jobs (order_id, created_at);
CREATE INDEX IF NOT EXISTS idx_print_jobs_printer   ON business_operations.print_jobs (printer_id) WHERE printer_id IS NOT NULL;

ALTER TABLE business_operations.print_jobs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'business_operations' AND tablename = 'print_jobs' AND policyname = 'print_jobs_isolation') THEN
    CREATE POLICY print_jobs_isolation ON business_operations.print_jobs
      USING (
        tenant_id        = current_setting('app.tenant_id',    true)::uuid
        AND workspace_id = current_setting('app.workspace_id', true)::uuid
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'business_operations.print_jobs'::regclass AND tgname = 'forbid_mutation_print_jobs') THEN
    CREATE TRIGGER forbid_mutation_print_jobs
      BEFORE UPDATE OR DELETE ON business_operations.print_jobs
      FOR EACH ROW EXECUTE FUNCTION business_operations.forbid_mutation();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'business_operations.print_jobs'::regclass AND tgname = 'forbid_truncate_print_jobs') THEN
    CREATE TRIGGER forbid_truncate_print_jobs
      BEFORE TRUNCATE ON business_operations.print_jobs
      FOR EACH STATEMENT EXECUTE FUNCTION business_operations.forbid_mutation();
  END IF;
END $$;

INSERT INTO _migrations (filename) VALUES ('0209_create_print_jobs.sql')
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
