-- OM-MEASURE-3: make every governed verdict source reference enforce its full scope in PostgreSQL.
-- The 0213 insert guard remains as a second layer. No verdict writer or new verdict state is enabled.
BEGIN;

-- A primary key on id alone cannot support a composite FK. These keys also make the
-- observation/version and attribution/observation relationships enforceable by the database.
ALTER TABLE outcome_monitoring.action_execution_verifications
  ADD CONSTRAINT om_verification_verdict_scope_key UNIQUE (id, tenant_id, workspace_id, business_id);
ALTER TABLE outcome_monitoring.outcome_observations
  ADD CONSTRAINT om_observation_verdict_scope_key UNIQUE (id, tenant_id, workspace_id, business_id);
ALTER TABLE outcome_monitoring.outcome_observation_versions
  ADD CONSTRAINT om_observation_version_verdict_scope_key UNIQUE (id, observation_id, tenant_id, workspace_id, business_id);
ALTER TABLE outcome_monitoring.outcome_attribution_runs
  ADD CONSTRAINT om_attribution_verdict_scope_key UNIQUE (id, observation_id, tenant_id, workspace_id, business_id);

ALTER TABLE outcome_monitoring.governed_outcome_verdicts
  ADD CONSTRAINT om_verdict_verification_scope FOREIGN KEY
    (execution_verification_id, tenant_id, workspace_id, business_id)
    REFERENCES outcome_monitoring.action_execution_verifications (id, tenant_id, workspace_id, business_id),
  ADD CONSTRAINT om_verdict_observation_scope FOREIGN KEY
    (observation_id, tenant_id, workspace_id, business_id)
    REFERENCES outcome_monitoring.outcome_observations (id, tenant_id, workspace_id, business_id),
  ADD CONSTRAINT om_verdict_version_scope FOREIGN KEY
    (observation_version_id, observation_id, tenant_id, workspace_id, business_id)
    REFERENCES outcome_monitoring.outcome_observation_versions (id, observation_id, tenant_id, workspace_id, business_id),
  ADD CONSTRAINT om_verdict_attribution_scope FOREIGN KEY
    (attribution_run_id, observation_id, tenant_id, workspace_id, business_id)
    REFERENCES outcome_monitoring.outcome_attribution_runs (id, observation_id, tenant_id, workspace_id, business_id),
  ADD CONSTRAINT om_verdict_observed_shape CHECK (outcome_state = 'OUTCOME_OBSERVED' AND approver_id IS NULL);

INSERT INTO _migrations (filename) VALUES ('0214_enforce_governed_verdict_scope.sql') ON CONFLICT (filename) DO NOTHING;
COMMIT;
