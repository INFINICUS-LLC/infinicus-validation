#!/usr/bin/env bash
# Grant only the privileges needed by the OM-MEASURE-5 assessment writer.
# Provision the LOGIN NOSUPERUSER NOBYPASSRLS role separately. No production use is implied.
set -euo pipefail
: "${ADMIN_DATABASE_URL:?ADMIN_DATABASE_URL is required}"
: "${OM_RUNNER_ROLE:?OM_RUNNER_ROLE is required}"

psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -v role="$OM_RUNNER_ROLE" <<'SQL'
DO $$ BEGIN
  IF to_regclass('outcome_monitoring.governed_outcome_verdicts') IS NULL OR
     NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'outcome_monitoring.governed_outcome_verdicts'::regclass
       AND attname = 'runner_service_account_id' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'OM-MEASURE-5 migration 0215 is required before runner grants';
  END IF;
END $$;
GRANT USAGE ON SCHEMA outcome_monitoring, identity TO :"role";
GRANT SELECT ON outcome_monitoring.action_execution_verifications,
  outcome_monitoring.governed_measurement_definitions,
  outcome_monitoring.outcome_observation_versions,
  outcome_monitoring.outcome_attribution_runs,
  identity.service_accounts TO :"role";
GRANT SELECT, INSERT ON outcome_monitoring.governed_outcome_verdicts TO :"role";
REVOKE UPDATE, DELETE, TRUNCATE ON outcome_monitoring.governed_outcome_verdicts FROM :"role";
SQL
