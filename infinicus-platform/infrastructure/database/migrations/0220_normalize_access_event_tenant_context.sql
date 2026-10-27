-- AUTH-LOCKOUT-1.DB-02: a transaction-local app.tenant_id can reset to the
-- empty string on a reused PostgreSQL connection. Treat that value as absent
-- for this policy's UUID comparison; tenant-scoped rows remain invisible.
-- The tenantless access-event branch and all existing table privileges remain.
BEGIN;

ALTER POLICY access_events_isolation ON audit.access_events
  USING (
    tenant_id IS NULL
    OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );

INSERT INTO _migrations (filename) VALUES ('0220_normalize_access_event_tenant_context.sql')
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
