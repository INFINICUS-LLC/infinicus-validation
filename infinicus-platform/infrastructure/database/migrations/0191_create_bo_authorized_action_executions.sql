-- Migration: 0191_create_bo_authorized_action_executions
-- P0-6c (BO execution engine): the Business Operations FACT of executing - or refusing/failing to execute - an authorized-action claim.
--
--   authorized_action_executions         ONE terminal row per claim (UNIQUE(claim_id)): SUCCEEDED | FAILED | REFUSED, written in the same
--                                        transaction as the mutation it describes (or as the refusal), so a crash leaves nothing half-done.
--   authorized_action_execution_attempts transient, non-terminal attempt log (status unavailable, authority unverifiable, operational errors)
--                                        used to bound retries (owner ruling O-3).
--
-- Both tables are append-only (UPDATE/DELETE/TRUNCATE refused for every role), tenant+workspace RLS FORCED, and stamped with the DATABASE clock.
-- A claim is NOT execution and confers no authority: an execution row exists only because the engine re-verified authority under locks.
--
-- Integrity enforced by the database itself (not only by the application):
--   * the execution is bound to its claim and receipt: package id, version, digest and scope must equal the claim's (trigger);
--   * SUCCEEDED requires authority verdict CURRENT, a recorded status-verification time not after the record time, and a mutation result of
--     APPLIED (with an after-state) or NO_CHANGE (without one); REFUSED/FAILED require NOT_APPLIED, a reason code and no after-state;
--   * the sealed evidence document and its SHA-256 digest are stored with the fact; a terminal row can never be amended;
--   * no attempt can be appended once the claim has a terminal row.
-- Thresholds (maximum status age, retry counts, backoff) are application policy and are NOT encoded here.
--
-- New tables only: no historical data is read, rewritten or backfilled. Idempotent. No GRANT or role statements.

BEGIN;

CREATE TABLE IF NOT EXISTS business_operations.authorized_action_executions (
  id                         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                  uuid        NOT NULL REFERENCES tenancy.tenants(id)     ON DELETE RESTRICT,
  workspace_id               uuid        NOT NULL REFERENCES tenancy.workspaces(id)  ON DELETE RESTRICT,
  business_id                uuid        NOT NULL REFERENCES platform.businesses(id) ON DELETE RESTRICT,
  claim_id                   uuid        NOT NULL REFERENCES business_operations.authorized_action_claims(id) ON DELETE RESTRICT,
  receipt_id                 uuid        NOT NULL,
  package_id                 uuid        NOT NULL,
  package_version            integer     NOT NULL CHECK (package_version >= 1),
  digest                     text        NOT NULL CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  action_type_code           text        NOT NULL CHECK (length(btrim(action_type_code)) > 0),
  action_type_schema_version text        NOT NULL CHECK (length(btrim(action_type_schema_version)) > 0),
  target_kind                text        NOT NULL CHECK (length(btrim(target_kind)) > 0),
  target_id                  text        NOT NULL CHECK (length(btrim(target_id)) > 0),

  outcome                    text        NOT NULL CHECK (outcome IN ('SUCCEEDED', 'FAILED', 'REFUSED')),
  reason_code                text        CHECK (reason_code IS NULL OR length(btrim(reason_code)) > 0),
  detail                     text        CHECK (detail IS NULL OR length(detail) <= 1000),
  mutation_result            text        NOT NULL CHECK (mutation_result IN ('APPLIED', 'NO_CHANGE', 'NOT_APPLIED')),

  balance_id                 uuid,
  before_state               jsonb,
  requested_state            jsonb,
  after_state                jsonb,
  preconditions              jsonb,

  authority_verdict          text        NOT NULL CHECK (authority_verdict IN ('CURRENT', 'REVOKED', 'UNVERIFIABLE', 'NOT_CHECKED')),
  status_verified_at         timestamptz,
  authority_verified_at      timestamptz,
  status_answer_digest       text        CHECK (status_answer_digest IS NULL OR status_answer_digest ~ '^sha256:[0-9a-f]{64}$'),
  provider_component         text,
  attempt_count              integer     NOT NULL CHECK (attempt_count >= 1),

  claimed_at                 timestamptz NOT NULL,
  execution_started_at       timestamptz NOT NULL,
  execution_completed_at     timestamptz NOT NULL,
  recorded_at                timestamptz NOT NULL DEFAULT clock_timestamp(),

  evidence                   jsonb       NOT NULL,
  evidence_digest            text        NOT NULL CHECK (evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
  correlation_id             uuid        NOT NULL,
  causation_id               uuid,

  CONSTRAINT authorized_action_executions_one_per_claim UNIQUE (claim_id),
  CONSTRAINT authorized_action_executions_package_key UNIQUE (package_id, package_version),
  CONSTRAINT authorized_action_executions_ms CHECK (
    claimed_at = date_trunc('milliseconds', claimed_at) AND execution_started_at = date_trunc('milliseconds', execution_started_at)
    AND execution_completed_at = date_trunc('milliseconds', execution_completed_at) AND recorded_at = date_trunc('milliseconds', recorded_at)
    AND (status_verified_at IS NULL OR status_verified_at = date_trunc('milliseconds', status_verified_at))
    AND (authority_verified_at IS NULL OR authority_verified_at = date_trunc('milliseconds', authority_verified_at))
  ),
  CONSTRAINT authorized_action_executions_time_order CHECK (
    execution_started_at <= execution_completed_at AND execution_completed_at <= recorded_at
  ),
  CONSTRAINT authorized_action_executions_outcome_shape CHECK (
    (outcome = 'SUCCEEDED' AND reason_code IS NULL AND mutation_result IN ('APPLIED', 'NO_CHANGE'))
    OR (outcome IN ('FAILED', 'REFUSED') AND reason_code IS NOT NULL AND mutation_result = 'NOT_APPLIED')
  ),
  CONSTRAINT authorized_action_executions_after_state_shape CHECK (
    (mutation_result = 'APPLIED') = (after_state IS NOT NULL)
  ),
  -- No success without fresh, proven authority: SUCCEEDED carries CURRENT authority and the time ABA proved it.
  CONSTRAINT authorized_action_executions_success_needs_authority CHECK (
    outcome <> 'SUCCEEDED' OR (
      authority_verdict = 'CURRENT' AND status_verified_at IS NOT NULL AND authority_verified_at IS NOT NULL
      AND status_answer_digest IS NOT NULL AND balance_id IS NOT NULL AND before_state IS NOT NULL AND requested_state IS NOT NULL
      AND status_verified_at <= execution_completed_at AND authority_verified_at <= execution_completed_at
    )
  ),
  CONSTRAINT authorized_action_executions_evidence_is_object CHECK (jsonb_typeof(evidence) = 'object'),
  CONSTRAINT authorized_action_executions_bounded CHECK (octet_length(evidence::text) <= 262144)
);

COMMENT ON TABLE business_operations.authorized_action_executions IS
  'Append-only. Business Operations truth of what happened to an authorized-action claim: one terminal row (SUCCEEDED | FAILED | REFUSED) per claim, with the authority facts judged under lock, the before/requested/after state, the sealed evidence document and its digest. Written in the same transaction as the mutation. ABA never reads or writes this table.';

CREATE TABLE IF NOT EXISTS business_operations.authorized_action_execution_attempts (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid        NOT NULL REFERENCES tenancy.tenants(id)     ON DELETE RESTRICT,
  workspace_id       uuid        NOT NULL REFERENCES tenancy.workspaces(id)  ON DELETE RESTRICT,
  business_id        uuid        NOT NULL REFERENCES platform.businesses(id) ON DELETE RESTRICT,
  claim_id           uuid        NOT NULL REFERENCES business_operations.authorized_action_claims(id) ON DELETE RESTRICT,
  attempt_number     integer     NOT NULL CHECK (attempt_number >= 1),
  outcome            text        NOT NULL CHECK (outcome IN ('RETRYABLE_REFUSAL', 'RETRYABLE_FAILURE')),
  reason_code        text        NOT NULL CHECK (length(btrim(reason_code)) > 0),
  detail             text        CHECK (detail IS NULL OR length(detail) <= 1000),
  authority_verdict  text        CHECK (authority_verdict IS NULL OR authority_verdict IN ('CURRENT', 'REVOKED', 'UNVERIFIABLE')),
  status_verified_at timestamptz,
  correlation_id     uuid        NOT NULL,
  attempted_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT authorized_action_execution_attempts_number_key UNIQUE (claim_id, attempt_number),
  CONSTRAINT authorized_action_execution_attempts_ms CHECK (
    attempted_at = date_trunc('milliseconds', attempted_at) AND (status_verified_at IS NULL OR status_verified_at = date_trunc('milliseconds', status_verified_at))
  )
);

COMMENT ON TABLE business_operations.authorized_action_execution_attempts IS
  'Append-only log of non-terminal execution attempts (status/authority not obtainable yet, operational errors). Bounds retries; carries no authority. A claim with a terminal execution row accepts no further attempts.';

CREATE INDEX IF NOT EXISTS authorized_action_executions_business_idx
  ON business_operations.authorized_action_executions (tenant_id, workspace_id, business_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS authorized_action_execution_attempts_claim_idx
  ON business_operations.authorized_action_execution_attempts (claim_id, attempt_number);

-- Binding to the claim, database-clock stamping and the "one terminal state" rule.
CREATE OR REPLACE FUNCTION business_operations.guard_authorized_action_execution_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  c RECORD;
  r RECORD;
  now_ts timestamptz := date_trunc('milliseconds', clock_timestamp());
BEGIN
  SELECT * INTO c FROM business_operations.authorized_action_claims WHERE id = NEW.claim_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'authorized_action_executions: the claim does not exist' USING ERRCODE = 'check_violation';
  END IF;
  IF c.receipt_id IS DISTINCT FROM NEW.receipt_id OR c.package_id IS DISTINCT FROM NEW.package_id OR c.package_version IS DISTINCT FROM NEW.package_version
     OR c.digest IS DISTINCT FROM NEW.digest OR c.tenant_id IS DISTINCT FROM NEW.tenant_id OR c.workspace_id IS DISTINCT FROM NEW.workspace_id
     OR c.business_id IS DISTINCT FROM NEW.business_id OR date_trunc('milliseconds', c.claimed_at) IS DISTINCT FROM NEW.claimed_at THEN
    RAISE EXCEPTION 'authorized_action_executions: the execution does not match its claim (receipt, package, digest, scope or claim time)' USING ERRCODE = 'check_violation';
  END IF;
  SELECT package INTO r FROM business_operations.authorized_action_receipts WHERE id = NEW.receipt_id;
  IF (r.package #>> '{action,type,code}') IS DISTINCT FROM NEW.action_type_code
     OR (r.package #>> '{action,type,schemaVersion}') IS DISTINCT FROM NEW.action_type_schema_version
     OR (r.package #>> '{action,target,kind}') IS DISTINCT FROM NEW.target_kind
     OR (r.package #>> '{action,target,id}') IS DISTINCT FROM NEW.target_id THEN
    RAISE EXCEPTION 'authorized_action_executions: the execution does not match the receipt action type or target' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.execution_started_at < c.claimed_at THEN
    RAISE EXCEPTION 'authorized_action_executions: an execution cannot start before its claim' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.execution_started_at > now_ts THEN
    RAISE EXCEPTION 'authorized_action_executions: the execution start is after the database clock' USING ERRCODE = 'check_violation';
  END IF;
  NEW.execution_completed_at := now_ts;
  NEW.recorded_at := now_ts;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_authorized_action_execution_insert ON business_operations.authorized_action_executions;
CREATE TRIGGER guard_authorized_action_execution_insert
  BEFORE INSERT ON business_operations.authorized_action_executions
  FOR EACH ROW EXECUTE FUNCTION business_operations.guard_authorized_action_execution_insert();

CREATE OR REPLACE FUNCTION business_operations.guard_authorized_action_execution_attempt_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  c RECORD;
BEGIN
  SELECT * INTO c FROM business_operations.authorized_action_claims WHERE id = NEW.claim_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'authorized_action_execution_attempts: the claim does not exist' USING ERRCODE = 'check_violation';
  END IF;
  IF c.tenant_id IS DISTINCT FROM NEW.tenant_id OR c.workspace_id IS DISTINCT FROM NEW.workspace_id OR c.business_id IS DISTINCT FROM NEW.business_id THEN
    RAISE EXCEPTION 'authorized_action_execution_attempts: the attempt scope does not match its claim' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM business_operations.authorized_action_executions e WHERE e.claim_id = NEW.claim_id) THEN
    RAISE EXCEPTION 'authorized_action_execution_attempts: the claim already has a terminal execution' USING ERRCODE = 'check_violation';
  END IF;
  NEW.attempted_at := date_trunc('milliseconds', clock_timestamp());
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_authorized_action_execution_attempt_insert ON business_operations.authorized_action_execution_attempts;
CREATE TRIGGER guard_authorized_action_execution_attempt_insert
  BEFORE INSERT ON business_operations.authorized_action_execution_attempts
  FOR EACH ROW EXECUTE FUNCTION business_operations.guard_authorized_action_execution_attempt_insert();

CREATE OR REPLACE FUNCTION business_operations.forbid_authorized_action_execution_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'business_operations.%: append-only table - % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['authorized_action_executions', 'authorized_action_execution_attempts'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS forbid_mutation_%1$s ON business_operations.%1$I', t);
    EXECUTE format('CREATE TRIGGER forbid_mutation_%1$s BEFORE UPDATE OR DELETE ON business_operations.%1$I FOR EACH ROW EXECUTE FUNCTION business_operations.forbid_authorized_action_execution_mutation()', t);
    EXECUTE format('DROP TRIGGER IF EXISTS forbid_truncate_%1$s ON business_operations.%1$I', t);
    EXECUTE format('CREATE TRIGGER forbid_truncate_%1$s BEFORE TRUNCATE ON business_operations.%1$I FOR EACH STATEMENT EXECUTE FUNCTION business_operations.forbid_authorized_action_execution_mutation()', t);
    EXECUTE format('ALTER TABLE business_operations.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE business_operations.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON business_operations.%I', t || '_isolation', t);
    EXECUTE format(
      'CREATE POLICY %I ON business_operations.%I USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid AND workspace_id = current_setting(''app.workspace_id'', true)::uuid)',
      t || '_isolation', t
    );
  END LOOP;
END $$;

INSERT INTO _migrations (filename) VALUES ('0191_create_bo_authorized_action_executions.sql')
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
