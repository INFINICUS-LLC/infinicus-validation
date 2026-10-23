-- OM-24 authority foundation. No default measurement policy, backfill, writer, or learning activation.
BEGIN;

CREATE TABLE outcome_monitoring.governed_measurement_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenancy.tenants(id),
  workspace_id uuid NOT NULL REFERENCES tenancy.workspaces(id),
  business_id uuid NOT NULL REFERENCES platform.businesses(id),
  action_type_code text NOT NULL CHECK (length(btrim(action_type_code)) > 0),
  action_type_schema_version text NOT NULL CHECK (length(btrim(action_type_schema_version)) > 0),
  metric_code text NOT NULL CHECK (length(btrim(metric_code)) > 0),
  definition_version integer NOT NULL CHECK (definition_version > 0),
  window_seconds integer NOT NULL CHECK (window_seconds > 0),
  baseline_seconds integer NOT NULL CHECK (baseline_seconds > 0),
  minimum_observations integer NOT NULL CHECK (minimum_observations > 0),
  attribution_rule_code text NOT NULL CHECK (length(btrim(attribution_rule_code)) > 0),
  success_direction text NOT NULL CHECK (success_direction IN ('increase','decrease')),
  success_threshold numeric NOT NULL,
  author_id uuid NOT NULL REFERENCES identity.users(id),
  approver_id uuid NOT NULL REFERENCES identity.users(id),
  approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT om_definition_separation CHECK (author_id <> approver_id),
  CONSTRAINT om_definition_version_unique UNIQUE (business_id, action_type_code, action_type_schema_version, metric_code, definition_version),
  CONSTRAINT om_definition_scope_unique UNIQUE (id, tenant_id, workspace_id, business_id)
);

CREATE TABLE outcome_monitoring.governed_outcome_verdicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenancy.tenants(id),
  workspace_id uuid NOT NULL REFERENCES tenancy.workspaces(id),
  business_id uuid NOT NULL REFERENCES platform.businesses(id),
  execution_verification_id uuid NOT NULL REFERENCES outcome_monitoring.action_execution_verifications(id),
  observation_id uuid NOT NULL REFERENCES outcome_monitoring.outcome_observations(id),
  observation_version_id uuid NOT NULL REFERENCES outcome_monitoring.outcome_observation_versions(id),
  definition_id uuid NOT NULL,
  -- OM-MEASURE-3 is storage only. The governed runner/approval act must arrive before VERIFIED can be written.
  outcome_state text NOT NULL CHECK (outcome_state = 'OUTCOME_OBSERVED'),
  input_digest text NOT NULL CHECK (input_digest ~ '^sha256:[0-9a-f]{64}$'),
  verdict_digest text NOT NULL CHECK (verdict_digest ~ '^sha256:[0-9a-f]{64}$'),
  measured_value numeric NOT NULL,
  baseline_value numeric NOT NULL,
  observation_count integer NOT NULL CHECK (observation_count > 0),
  baseline_opened_at timestamptz NOT NULL,
  baseline_closed_at timestamptz NOT NULL,
  window_opened_at timestamptz NOT NULL,
  window_closed_at timestamptz NOT NULL,
  attribution_run_id uuid REFERENCES outcome_monitoring.outcome_attribution_runs(id),
  runner_id uuid NOT NULL REFERENCES identity.users(id),
  approver_id uuid REFERENCES identity.users(id),
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT om_verdict_window CHECK (window_closed_at > window_opened_at),
  CONSTRAINT om_verdict_baseline CHECK (baseline_closed_at > baseline_opened_at AND baseline_closed_at <= window_opened_at),
  CONSTRAINT om_verdict_approval CHECK (outcome_state <> 'OUTCOME_VERIFIED' OR (approver_id IS NOT NULL AND attribution_run_id IS NOT NULL)),
  CONSTRAINT om_verdict_scope_unique UNIQUE (id, tenant_id, workspace_id, business_id),
  CONSTRAINT om_verdict_definition_scope FOREIGN KEY (definition_id, tenant_id, workspace_id, business_id)
    REFERENCES outcome_monitoring.governed_measurement_definitions(id, tenant_id, workspace_id, business_id)
);

CREATE TABLE outcome_monitoring.om24_publication_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenancy.tenants(id),
  workspace_id uuid NOT NULL REFERENCES tenancy.workspaces(id),
  business_id uuid NOT NULL REFERENCES platform.businesses(id),
  publication_package_id uuid NOT NULL REFERENCES outcome_monitoring.om_publication_packages(id),
  feedback_package_version_id uuid NOT NULL REFERENCES outcome_monitoring.learning_feedback_package_versions(id),
  verdict_id uuid NOT NULL,
  governed_detail jsonb NOT NULL CHECK (jsonb_typeof(governed_detail) = 'object'),
  governed_detail_digest text NOT NULL CHECK (governed_detail_digest ~ '^sha256:[0-9a-f]{64}$'),
  package_digest text NOT NULL CHECK (package_digest ~ '^sha256:[0-9a-f]{64}$'),
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT om24_receipt_one_per_publication UNIQUE (publication_package_id),
  CONSTRAINT om24_receipt_verdict_scope FOREIGN KEY (verdict_id, tenant_id, workspace_id, business_id)
    REFERENCES outcome_monitoring.governed_outcome_verdicts(id, tenant_id, workspace_id, business_id)
);

CREATE OR REPLACE FUNCTION outcome_monitoring.guard_governed_source_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  def outcome_monitoring.governed_measurement_definitions%ROWTYPE;
  verification outcome_monitoring.action_execution_verifications%ROWTYPE;
  pub outcome_monitoring.om_publication_packages%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'governed_outcome_verdicts' THEN
    SELECT * INTO def FROM outcome_monitoring.governed_measurement_definitions WHERE id = NEW.definition_id;
    SELECT * INTO verification FROM outcome_monitoring.action_execution_verifications WHERE id = NEW.execution_verification_id;
    IF def.id IS NULL OR verification.id IS NULL OR
       verification.tenant_id <> NEW.tenant_id OR verification.workspace_id <> NEW.workspace_id OR verification.business_id <> NEW.business_id OR
       verification.action_type_code <> def.action_type_code OR verification.action_type_schema_version <> def.action_type_schema_version OR
       verification.execution_outcome <> 'SUCCEEDED' OR verification.mutation_result <> 'APPLIED' OR
       NEW.observation_count < def.minimum_observations OR
       NEW.baseline_closed_at - NEW.baseline_opened_at <> make_interval(secs => def.baseline_seconds) OR
       NEW.window_closed_at - NEW.window_opened_at <> make_interval(secs => def.window_seconds) OR
       NEW.window_closed_at > clock_timestamp() OR
       (NEW.outcome_state = 'OUTCOME_VERIFIED' AND (NEW.approver_id <> def.approver_id OR NEW.approver_id = NEW.runner_id)) OR
       NOT EXISTS (SELECT 1 FROM outcome_monitoring.outcome_observation_versions ov WHERE ov.id = NEW.observation_version_id AND ov.observation_id = NEW.observation_id AND ov.tenant_id = NEW.tenant_id AND ov.workspace_id = NEW.workspace_id AND ov.business_id = NEW.business_id) OR
       (NEW.attribution_run_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM outcome_monitoring.outcome_attribution_runs ar WHERE ar.id = NEW.attribution_run_id
           AND ar.observation_id = NEW.observation_id AND ar.tenant_id = NEW.tenant_id AND ar.workspace_id = NEW.workspace_id AND ar.business_id = NEW.business_id))
    THEN RAISE EXCEPTION 'governed verdict lacks scoped measurement authority' USING ERRCODE = 'check_violation'; END IF;
  ELSIF TG_TABLE_NAME = 'om24_publication_receipts' THEN
    SELECT * INTO pub FROM outcome_monitoring.om_publication_packages WHERE id = NEW.publication_package_id;
    IF NEW.governed_detail_digest <> ('sha256:' || encode(digest(NEW.governed_detail::text, 'sha256'), 'hex')) OR
       pub.id IS NULL OR pub.tenant_id <> NEW.tenant_id OR pub.workspace_id <> NEW.workspace_id OR pub.business_id <> NEW.business_id OR
       pub.publication_status NOT IN ('dispatched','acknowledged') OR pub.target_layer <> 'continuous_learning' OR pub.target_block <> 'CL-01' OR
       NOT EXISTS (
         SELECT 1 FROM outcome_monitoring.learning_feedback_package_versions fv
         JOIN outcome_monitoring.learning_feedback_packages fb ON fb.id = fv.feedback_package_id
         JOIN outcome_monitoring.outcome_reviews review ON review.id = fb.review_id
         JOIN outcome_monitoring.governed_outcome_verdicts verdict ON verdict.id = NEW.verdict_id
         WHERE fv.id = NEW.feedback_package_version_id AND fb.id = pub.feedback_package_id
           AND review.observation_id = verdict.observation_id AND verdict.outcome_state = 'OUTCOME_VERIFIED'
           AND fv.tenant_id = NEW.tenant_id AND fv.workspace_id = NEW.workspace_id AND fv.business_id = NEW.business_id
       )
    THEN RAISE EXCEPTION 'OM-24 receipt lacks a scoped verified verdict' USING ERRCODE = 'check_violation'; END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_governed_outcome_verdict_insert BEFORE INSERT ON outcome_monitoring.governed_outcome_verdicts
  FOR EACH ROW EXECUTE FUNCTION outcome_monitoring.guard_governed_source_insert();
CREATE TRIGGER guard_om24_publication_receipt_insert BEFORE INSERT ON outcome_monitoring.om24_publication_receipts
  FOR EACH ROW EXECUTE FUNCTION outcome_monitoring.guard_governed_source_insert();

CREATE OR REPLACE FUNCTION outcome_monitoring.forbid_governed_source_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'governed OM source is append-only' USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER immutable_governed_measurement_definitions BEFORE UPDATE OR DELETE ON outcome_monitoring.governed_measurement_definitions
  FOR EACH ROW EXECUTE FUNCTION outcome_monitoring.forbid_governed_source_mutation();
CREATE TRIGGER immutable_governed_outcome_verdicts BEFORE UPDATE OR DELETE ON outcome_monitoring.governed_outcome_verdicts
  FOR EACH ROW EXECUTE FUNCTION outcome_monitoring.forbid_governed_source_mutation();
CREATE TRIGGER immutable_om24_publication_receipts BEFORE UPDATE OR DELETE ON outcome_monitoring.om24_publication_receipts
  FOR EACH ROW EXECUTE FUNCTION outcome_monitoring.forbid_governed_source_mutation();
CREATE TRIGGER immutable_governed_measurement_definitions_truncate BEFORE TRUNCATE ON outcome_monitoring.governed_measurement_definitions
  FOR EACH STATEMENT EXECUTE FUNCTION outcome_monitoring.forbid_governed_source_mutation();
CREATE TRIGGER immutable_governed_outcome_verdicts_truncate BEFORE TRUNCATE ON outcome_monitoring.governed_outcome_verdicts
  FOR EACH STATEMENT EXECUTE FUNCTION outcome_monitoring.forbid_governed_source_mutation();
CREATE TRIGGER immutable_om24_publication_receipts_truncate BEFORE TRUNCATE ON outcome_monitoring.om24_publication_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION outcome_monitoring.forbid_governed_source_mutation();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['governed_measurement_definitions','governed_outcome_verdicts','om24_publication_receipts'] LOOP
    EXECUTE format('ALTER TABLE outcome_monitoring.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE outcome_monitoring.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY %I ON outcome_monitoring.%I USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid AND workspace_id = current_setting(''app.workspace_id'', true)::uuid)', table_name || '_scope', table_name);
  END LOOP;
END $$;

INSERT INTO _migrations (filename) VALUES ('0213_create_om_governed_publication_source.sql') ON CONFLICT (filename) DO NOTHING;
COMMIT;
