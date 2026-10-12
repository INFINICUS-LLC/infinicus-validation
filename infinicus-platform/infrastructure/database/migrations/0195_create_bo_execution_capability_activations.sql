-- Migration: 0195_create_bo_execution_capability_activations
-- P0-6e (controlled execution wiring): the GOVERNED ACTIVATION record - the second of the three independent keys of the authorized-action
-- execution gate (planning decision 16; owner ruling O-11).
--
--   key 1  build-time capability registry   (code)        what Business Operations CAN execute
--   key 2  THIS TABLE                       (database)     whether a supported action type MAY execute for ONE business   <-- here
--   key 3  global kill switch               (process)      can only REMOVE capability, never enable
--
-- NO ROW (or a latest row that is DISABLED) = CLOSED. The table answers one question only - "may this supported action type execute for this
-- business?" It is not authorization (ABA owns that), not a claim, not a status check, and it replaces none of them.
--
-- Append-only and version-chained per (business, action type, schema version): version n+1 may only follow version n. A change of state
-- is a new row; nothing is updated or deleted, so the history of who enabled or disabled what, under which permission, and why, is the record.
-- Scope is tenant + workspace + business (the business must belong to the stated tenant and workspace). There is no wildcard row.
--
-- NO BACKFILL and NO SEED: an existing business is CLOSED until an administrator enables it through the audited administration path.
-- Idempotent. No GRANT or role statements.

BEGIN;

CREATE TABLE IF NOT EXISTS business_operations.execution_capability_activations (
  id                         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                  uuid        NOT NULL REFERENCES tenancy.tenants(id)     ON DELETE RESTRICT,
  workspace_id               uuid        NOT NULL REFERENCES tenancy.workspaces(id)  ON DELETE RESTRICT,
  business_id                uuid        NOT NULL REFERENCES platform.businesses(id) ON DELETE RESTRICT,
  action_type_code           text        NOT NULL CHECK (length(btrim(action_type_code)) > 0 AND length(action_type_code) <= 200),
  action_type_schema_version text        NOT NULL CHECK (length(btrim(action_type_schema_version)) > 0 AND length(action_type_schema_version) <= 50),
  version                    integer     NOT NULL CHECK (version >= 1),
  state                      text        NOT NULL CHECK (state IN ('ENABLED', 'DISABLED')),
  actor_user_id              uuid        NOT NULL,
  permission_code            text        NOT NULL CHECK (length(btrim(permission_code)) > 0 AND length(permission_code) <= 100),
  reason                     text        NOT NULL CHECK (length(btrim(reason)) > 0 AND length(reason) <= 500),
  recorded_at                timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT execution_capability_activations_version_key UNIQUE (business_id, action_type_code, action_type_schema_version, version),
  CONSTRAINT execution_capability_activations_ms CHECK (recorded_at = date_trunc('milliseconds', recorded_at))
);

COMMENT ON TABLE business_operations.execution_capability_activations IS
  'Append-only, version-chained governed activation of a supported authorized-action type for one business. No row, or a latest DISABLED row, means CLOSED. It answers only "may this type execute here?" - never authorization, claim, or status. No backfill, no seed, no wildcard.';

CREATE INDEX IF NOT EXISTS execution_capability_activations_latest_idx
  ON business_operations.execution_capability_activations (business_id, action_type_code, action_type_schema_version, version DESC);

CREATE OR REPLACE FUNCTION business_operations.guard_execution_capability_activation_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  latest integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM platform.businesses b WHERE b.id = NEW.business_id AND b.tenant_id = NEW.tenant_id AND b.workspace_id = NEW.workspace_id) THEN
    RAISE EXCEPTION 'execution_capability_activations: the business does not belong to the stated tenant and workspace' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('execution_capability_activations:' || NEW.business_id::text || ':' || NEW.action_type_code || '@' || NEW.action_type_schema_version, 0));
  SELECT max(version) INTO latest FROM business_operations.execution_capability_activations
   WHERE business_id = NEW.business_id AND action_type_code = NEW.action_type_code AND action_type_schema_version = NEW.action_type_schema_version;
  IF NEW.version IS DISTINCT FROM coalesce(latest, 0) + 1 THEN
    RAISE EXCEPTION 'execution_capability_activations: version % does not follow version %', NEW.version, coalesce(latest, 0) USING ERRCODE = 'check_violation';
  END IF;
  NEW.recorded_at := date_trunc('milliseconds', clock_timestamp());
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_execution_capability_activation_insert ON business_operations.execution_capability_activations;
CREATE TRIGGER guard_execution_capability_activation_insert
  BEFORE INSERT ON business_operations.execution_capability_activations
  FOR EACH ROW EXECUTE FUNCTION business_operations.guard_execution_capability_activation_insert();

CREATE OR REPLACE FUNCTION business_operations.forbid_execution_capability_activation_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'business_operations.%: append-only table - % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

DROP TRIGGER IF EXISTS forbid_mutation_execution_capability_activations ON business_operations.execution_capability_activations;
CREATE TRIGGER forbid_mutation_execution_capability_activations
  BEFORE UPDATE OR DELETE ON business_operations.execution_capability_activations
  FOR EACH ROW EXECUTE FUNCTION business_operations.forbid_execution_capability_activation_mutation();
DROP TRIGGER IF EXISTS forbid_truncate_execution_capability_activations ON business_operations.execution_capability_activations;
CREATE TRIGGER forbid_truncate_execution_capability_activations
  BEFORE TRUNCATE ON business_operations.execution_capability_activations
  FOR EACH STATEMENT EXECUTE FUNCTION business_operations.forbid_execution_capability_activation_mutation();

ALTER TABLE business_operations.execution_capability_activations ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_operations.execution_capability_activations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS execution_capability_activations_isolation ON business_operations.execution_capability_activations;
CREATE POLICY execution_capability_activations_isolation ON business_operations.execution_capability_activations
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid AND workspace_id = current_setting('app.workspace_id', true)::uuid);

INSERT INTO _migrations (filename) VALUES ('0195_create_bo_execution_capability_activations.sql')
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
