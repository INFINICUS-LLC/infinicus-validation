-- Migration: 0181_audit_events_append_only
-- P0-5/P0-6 preparation, Block A - audit.audit_events becomes append-only at the database level.
--
-- 0006 documented audit.audit_events as append-only but enforced it only by convention. Governance history (ABA authoring,
-- authority provenance references, package issuance detail) must not be alterable after insertion by any role.
--
-- Scope: UPDATE, DELETE and TRUNCATE are rejected unconditionally. INSERT, RLS, columns, indexes and every reader are
-- unchanged. No data is moved, rewritten or backfilled. The function name `forbid_mutation` deliberately matches the
-- repository convention (0049, 0062, 0076, 0091, 0106, 0121, 0136) that delete-tenant-data.mjs uses to discover
-- append-only tables, so a tenant erasure retains these rows and reports them instead of aborting.
--
-- Idempotent: CREATE OR REPLACE for the function, DROP TRIGGER IF EXISTS before each CREATE TRIGGER.
-- No GRANT or role statements (role provisioning is environment-specific, see grant-app-role.sh).

BEGIN;

CREATE OR REPLACE FUNCTION audit.forbid_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit.%: append-only table - % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

DROP TRIGGER IF EXISTS forbid_mutation_audit_events ON audit.audit_events;
CREATE TRIGGER forbid_mutation_audit_events
  BEFORE UPDATE OR DELETE ON audit.audit_events
  FOR EACH ROW EXECUTE FUNCTION audit.forbid_mutation();

DROP TRIGGER IF EXISTS forbid_truncate_audit_events ON audit.audit_events;
CREATE TRIGGER forbid_truncate_audit_events
  BEFORE TRUNCATE ON audit.audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit.forbid_mutation();

INSERT INTO _migrations (filename) VALUES ('0181_audit_events_append_only.sql')
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
