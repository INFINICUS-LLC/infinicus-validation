-- OM-MEASURE-5: append-only, idempotent pending/inconclusive assessment storage.
-- OBSERVED remains closed until governed attribution and observation evidence are available.
BEGIN;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM outcome_monitoring.governed_outcome_verdicts) THEN
    RAISE EXCEPTION '0215 requires review of existing governed verdicts before changing their shape';
  END IF;
END $$;

ALTER TABLE outcome_monitoring.governed_outcome_verdicts
  DROP CONSTRAINT governed_outcome_verdicts_outcome_state_check,
  DROP CONSTRAINT om_verdict_observed_shape,
  DROP CONSTRAINT om_verdict_approval,
  ALTER COLUMN observation_id DROP NOT NULL,
  ALTER COLUMN observation_version_id DROP NOT NULL,
  ALTER COLUMN definition_id DROP NOT NULL,
  ALTER COLUMN measured_value DROP NOT NULL,
  ALTER COLUMN baseline_value DROP NOT NULL,
  ALTER COLUMN observation_count DROP NOT NULL,
  ALTER COLUMN baseline_opened_at DROP NOT NULL,
  ALTER COLUMN baseline_closed_at DROP NOT NULL,
  ALTER COLUMN window_opened_at DROP NOT NULL,
  ALTER COLUMN window_closed_at DROP NOT NULL,
  ALTER COLUMN runner_id DROP NOT NULL,
  ADD COLUMN runner_service_account_id uuid NOT NULL REFERENCES identity.service_accounts(id),
  ADD COLUMN reason_code text NOT NULL,
  ADD CONSTRAINT om_verdict_state CHECK (outcome_state IN ('OUTCOME_PENDING','OUTCOME_INCONCLUSIVE')),
  ADD CONSTRAINT om_verdict_reason CHECK (reason_code IN (
    'NO_DEFINITION','NOTHING_APPLIED','SCOPE_MISMATCH','WINDOW_OPEN','SOURCE_UNAVAILABLE',
    'BASELINE_MISSING','INSUFFICIENT_DATA','DATA_QUALITY','ATTRIBUTION_UNAVAILABLE','MEASURED')),
  ADD CONSTRAINT om_verdict_assessment_shape CHECK (
    (outcome_state IN ('OUTCOME_PENDING','OUTCOME_INCONCLUSIVE') AND reason_code <> 'MEASURED'
      AND observation_id IS NULL AND observation_version_id IS NULL AND measured_value IS NULL
      AND baseline_value IS NULL AND observation_count IS NULL AND baseline_opened_at IS NULL
      AND baseline_closed_at IS NULL AND window_opened_at IS NULL AND window_closed_at IS NULL
      AND attribution_run_id IS NULL AND runner_id IS NULL AND approver_id IS NULL)
  );

CREATE UNIQUE INDEX om_verdict_assessment_idempotency ON outcome_monitoring.governed_outcome_verdicts
  (execution_verification_id, coalesce(definition_id, '00000000-0000-0000-0000-000000000000'::uuid),
   outcome_state, reason_code, input_digest);

CREATE OR REPLACE FUNCTION outcome_monitoring.guard_governed_measurement_verdict_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v outcome_monitoring.action_execution_verifications%ROWTYPE;
  d outcome_monitoring.governed_measurement_definitions%ROWTYPE;
BEGIN
  NEW.issued_at := clock_timestamp();
  IF NOT EXISTS (SELECT 1 FROM identity.service_accounts s
    WHERE s.id = NEW.runner_service_account_id AND s.tenant_id = NEW.tenant_id
      AND s.workspace_id = NEW.workspace_id AND s.status = 'active') THEN
    RAISE EXCEPTION 'governed verdict requires an active scoped runner service account' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v FROM outcome_monitoring.action_execution_verifications WHERE id = NEW.execution_verification_id;
  IF v.id IS NULL OR v.tenant_id <> NEW.tenant_id OR v.workspace_id <> NEW.workspace_id OR v.business_id <> NEW.business_id THEN
    RAISE EXCEPTION 'governed verdict execution scope mismatch' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.definition_id IS NOT NULL THEN
    SELECT * INTO d FROM outcome_monitoring.governed_measurement_definitions WHERE id = NEW.definition_id;
    IF d.id IS NULL OR d.tenant_id <> NEW.tenant_id OR d.workspace_id <> NEW.workspace_id OR d.business_id <> NEW.business_id
       OR d.action_type_code <> v.action_type_code OR d.action_type_schema_version <> v.action_type_schema_version THEN
      RAISE EXCEPTION 'governed verdict definition scope mismatch' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.reason_code NOT IN ('NO_DEFINITION','NOTHING_APPLIED','SCOPE_MISMATCH','DATA_QUALITY') THEN
    RAISE EXCEPTION 'governed verdict needs a definition for this assessment reason' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.outcome_state = 'OUTCOME_PENDING' AND (v.execution_outcome <> 'SUCCEEDED' OR v.mutation_result <> 'APPLIED') THEN
    RAISE EXCEPTION 'pending measurement requires an applied execution' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER guard_governed_outcome_verdict_insert ON outcome_monitoring.governed_outcome_verdicts;
CREATE TRIGGER guard_governed_outcome_verdict_insert BEFORE INSERT ON outcome_monitoring.governed_outcome_verdicts
  FOR EACH ROW EXECUTE FUNCTION outcome_monitoring.guard_governed_measurement_verdict_insert();

INSERT INTO _migrations (filename) VALUES ('0215_record_governed_measurement_assessments.sql') ON CONFLICT (filename) DO NOTHING;
COMMIT;
