-- Migration: 0208_create_printers
-- POS-8b (printer registry). Additive only: one new table, nothing existing is touched, nothing is backfilled.
--
-- business_operations.printers: the printers a business has declared (name, what it prints, how it is connected, paper width).
--   - kind        'receipt' (customer receipts) | 'kitchen' (order tickets; routing to it arrives in 8c);
--   - connection  'browser' (the browser's own print path, POS-8a) | 'network' | 'bluetooth' | 'usb' (reached through the device shell, POS-8d);
--   - paper_mm    58 or 80, the width the receipt is laid out for.
-- The registry deliberately holds NO network address, MAC address or device path: the device shell keeps the physical address of each printer on the
-- device itself (contract in docs/implementation-queue/BLOCK-POS-8D1-DEVICE-BRIDGE.md). The database knows that a printer exists and how it is used.
--
-- Invariants enforced here, not only in application code:
--   * name is 1 to 80 characters, and unique per business among ACTIVE printers (case-insensitive);
--   * at most one ACTIVE default printer per business and kind (partial unique index);
--   * a retired printer is never the default, and retired_at is set exactly when status = 'retired' (printers are retired, never deleted, so the
--     history of which printer was configured stays intact).
-- Tenant isolation: same null-safe, fail-closed policy as every business_operations table (tenant_id AND workspace_id). updated_at via set_updated_at().
--
-- ROLLBACK (no data outside this table is affected; only valid before any printer rows matter):
--   DROP TABLE business_operations.printers;
--   DELETE FROM _migrations WHERE filename = '0208_create_printers.sql';   -- only if the ledger entry must be removed
--
-- Idempotent. No GRANT/ROLE statements (grant-app-role.sh covers new tables through its default privileges). Not applied live.

BEGIN;

CREATE TABLE IF NOT EXISTS business_operations.printers (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid        NOT NULL REFERENCES tenancy.tenants(id)     ON DELETE RESTRICT,
  workspace_id  uuid        NOT NULL REFERENCES tenancy.workspaces(id)  ON DELETE RESTRICT,
  business_id   uuid        NOT NULL REFERENCES platform.businesses(id) ON DELETE RESTRICT,
  name          text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80 AND name = btrim(name)),
  kind          text        NOT NULL CHECK (kind IN ('receipt','kitchen')),
  connection    text        NOT NULL CHECK (connection IN ('browser','network','bluetooth','usb')),
  paper_mm      smallint    NOT NULL CHECK (paper_mm IN (58, 80)),
  is_default    boolean     NOT NULL DEFAULT false,
  status        text        NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  created_by    text,
  retired_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT printers_retired_consistent CHECK ((status = 'retired') = (retired_at IS NOT NULL)),
  CONSTRAINT printers_retired_not_default CHECK (status = 'active' OR is_default = false)
);

CREATE INDEX IF NOT EXISTS idx_printers_tenant    ON business_operations.printers (tenant_id);
CREATE INDEX IF NOT EXISTS idx_printers_workspace ON business_operations.printers (workspace_id);
CREATE INDEX IF NOT EXISTS idx_printers_business  ON business_operations.printers (business_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_printers_active_name_per_business
  ON business_operations.printers (business_id, lower(name))
  WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS idx_printers_one_default_per_business_kind
  ON business_operations.printers (business_id, kind)
  WHERE is_default AND status = 'active';

ALTER TABLE business_operations.printers ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'business_operations' AND tablename = 'printers' AND policyname = 'printers_isolation') THEN
    CREATE POLICY printers_isolation ON business_operations.printers
      USING (
        tenant_id        = current_setting('app.tenant_id',    true)::uuid
        AND workspace_id = current_setting('app.workspace_id', true)::uuid
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'business_operations.printers'::regclass AND tgname = 'set_updated_at_printers') THEN
    CREATE TRIGGER set_updated_at_printers
      BEFORE UPDATE ON business_operations.printers
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

INSERT INTO _migrations (filename) VALUES ('0208_create_printers.sql')
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
