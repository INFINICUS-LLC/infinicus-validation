-- Migration: 0194_create_om_action_execution_verifications
-- P0-6d (Outcome Monitoring intake of `operations.action.executed@1`): the OM record that an execution fact reported by Business Operations
-- was VERIFIED - real, in scope and untampered - together with what OM can (not) yet say about its OUTCOME.
--
--   execution_state  EXECUTION_VERIFIED only: OM proved the execution FACT. It says nothing about whether the action worked.
--   outcome_state    OUTCOME_PENDING | OUTCOME_INCONCLUSIVE only. The remaining outcome states (OBSERVED, VERIFIED, FAILED) are
--                    refused by the database until an authoritative measurement model exists (see P0-6d_OUTCOME_MEASUREMENT_AUTHORITY.md);
--                    an observed or verified outcome cannot be fabricated, and Continuous Learning can use only OUTCOME_VERIFIED.
--
-- Ownership: Business Operations owns the execution truth (business_operations.authorized_action_executions). This table holds a REFERENCE
-- (execution id + evidence digest) and OM's own verdicts; it copies no evidence document, has no foreign key into Business Operations
-- storage, and is never a second source of execution truth. OM never writes a Business Operations table.
--
-- Append-only (UPDATE/DELETE/TRUNCATE refused for every role), tenant+workspace RLS FORCED, verified_at stamped from the DATABASE clock.
-- One verification per execution per business (idempotent intake). New table only: no historical data is read, rewritten or backfilled.
-- Idempotent. No GRANT or role statements.

BEGIN;

CREATE TABLE IF NOT EXISTS outcome_monitoring.action_execution_verifications (
  id                         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                  uuid        NOT NULL REFERENCES tenancy.tenants(id)     ON DELETE RESTRICT,
  workspace_id               uuid        NOT NULL REFERENCES tenancy.workspaces(id)  ON DELETE RESTRICT,
  business_id                uuid        NOT NULL REFERENCES platform.businesses(id) ON DELETE RESTRICT,
  execution_id               uuid        NOT NULL,
  source_event_id            uuid        NOT NULL,
  contract_version           text        NOT NULL CHECK (contract_version = 'execution-evidence/1'),
  evidence_digest            text        NOT NULL CHECK (evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
  package_id                 uuid        NOT NULL,
  package_version            integer     NOT NULL CHECK (package_version >= 1),
  claim_id                   uuid        NOT NULL,
  approved_action_id         uuid,
  monitored_action_id        uuid        REFERENCES outcome_monitoring.monitored_actions(id) ON DELETE RESTRICT,
  action_type_code           text        NOT NULL CHECK (length(btrim(action_type_code)) > 0),
  action_type_schema_version text        NOT NULL CHECK (length(btrim(action_type_schema_version)) > 0),
  target_kind                text        NOT NULL CHECK (length(btrim(target_kind)) > 0),
  target_id                  text        NOT NULL CHECK (length(btrim(target_id)) > 0),
  execution_outcome          text        NOT NULL CHECK (execution_outcome IN ('SUCCEEDED', 'REFUSED', 'FAILED')),
  mutation_result            text        NOT NULL CHECK (mutation_result IN ('APPLIED', 'NO_CHANGE', 'NOT_APPLICABLE')),
  execution_recorded_at      timestamptz NOT NULL,
  execution_state            text        NOT NULL CHECK (execution_state = 'EXECUTION_VERIFIED'),
  outcome_state              text        NOT NULL CHECK (outcome_state IN ('OUTCOME_PENDING', 'OUTCOME_INCONCLUSIVE')),
  outcome_state_reason       text        NOT NULL CHECK (length(btrim(outcome_state_reason)) > 0 AND length(outcome_state_reason) <= 200),
  verified_at                timestamptz NOT NULL DEFAULT clock_timestamp(),
  correlation_id             uuid        NOT NULL,
  causation_id               uuid,

  CONSTRAINT action_execution_verifications_one_per_execution UNIQUE (business_id, execution_id),
  CONSTRAINT action_execution_verifications_ms CHECK (
    verified_at = date_trunc('milliseconds', verified_at) AND execution_recorded_at = date_trunc('milliseconds', execution_recorded_at)
  ),
  -- Only a change that was actually APPLIED by a SUCCEEDED execution can have a pending effect to observe. A refused, failed or no-change
  -- execution has nothing to measure, so it can never be PENDING (and so never heads towards learning).
  CONSTRAINT action_execution_verifications_pending_needs_applied CHECK (
    outcome_state <> 'OUTCOME_PENDING' OR (execution_outcome = 'SUCCEEDED' AND mutation_result = 'APPLIED')
  ),
  CONSTRAINT action_execution_verifications_outcome_shape CHECK (
    (execution_outcome = 'SUCCEEDED' AND mutation_result IN ('APPLIED', 'NO_CHANGE'))
    OR (execution_outcome IN ('REFUSED', 'FAILED') AND mutation_result = 'NOT_APPLICABLE')
  )
);

COMMENT ON TABLE outcome_monitoring.action_execution_verifications IS
  'Append-only. OM''s verification that a Business Operations execution fact is real, in scope and untampered (EXECUTION_VERIFIED) and what OM can currently say about its outcome (OUTCOME_PENDING | OUTCOME_INCONCLUSIVE only; observed/verified outcomes need an authoritative measurement model that does not exist yet). Holds a reference + digest, never a copy of the evidence and never a claim of business effect.';

CREATE INDEX IF NOT EXISTS action_execution_verifications_business_idx
  ON outcome_monitoring.action_execution_verifications (tenant_id, workspace_id, business_id, verified_at DESC);
CREATE INDEX IF NOT EXISTS action_execution_verifications_monitored_idx
  ON outcome_monitoring.action_execution_verifications (monitored_action_id) WHERE monitored_action_id IS NOT NULL;

CREATE OR REPLACE FUNCTION outcome_monitoring.guard_action_execution_verification_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.verified_at := date_trunc('milliseconds', clock_timestamp());
  IF NEW.execution_recorded_at > NEW.verified_at THEN
    RAISE EXCEPTION 'action_execution_verifications: the execution cannot be recorded after the database clock' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_action_execution_verification_insert ON outcome_monitoring.action_execution_verifications;
CREATE TRIGGER guard_action_execution_verification_insert
  BEFORE INSERT ON outcome_monitoring.action_execution_verifications
  FOR EACH ROW EXECUTE FUNCTION outcome_monitoring.guard_action_execution_verification_insert();

CREATE OR REPLACE FUNCTION outcome_monitoring.forbid_action_execution_verification_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'outcome_monitoring.%: append-only table - % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

DROP TRIGGER IF EXISTS forbid_mutation_action_execution_verifications ON outcome_monitoring.action_execution_verifications;
CREATE TRIGGER forbid_mutation_action_execution_verifications
  BEFORE UPDATE OR DELETE ON outcome_monitoring.action_execution_verifications
  FOR EACH ROW EXECUTE FUNCTION outcome_monitoring.forbid_action_execution_verification_mutation();
DROP TRIGGER IF EXISTS forbid_truncate_action_execution_verifications ON outcome_monitoring.action_execution_verifications;
CREATE TRIGGER forbid_truncate_action_execution_verifications
  BEFORE TRUNCATE ON outcome_monitoring.action_execution_verifications
  FOR EACH STATEMENT EXECUTE FUNCTION outcome_monitoring.forbid_action_execution_verification_mutation();

ALTER TABLE outcome_monitoring.action_execution_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE outcome_monitoring.action_execution_verifications FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS action_execution_verifications_tenant_isolation ON outcome_monitoring.action_execution_verifications;
CREATE POLICY action_execution_verifications_tenant_isolation ON outcome_monitoring.action_execution_verifications
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid AND workspace_id = current_setting('app.workspace_id', true)::uuid);

INSERT INTO _migrations (filename) VALUES ('0194_create_om_action_execution_verifications.sql')
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
