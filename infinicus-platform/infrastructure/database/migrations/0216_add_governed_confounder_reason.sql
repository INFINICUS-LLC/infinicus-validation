-- OM-MEASURE-6: preserve a stable fail-closed reason when BO evidence shows a confounder.
-- No new verdict state, attribution pass, or learning authority is enabled.
BEGIN;
ALTER TABLE outcome_monitoring.governed_outcome_verdicts DROP CONSTRAINT om_verdict_reason;
ALTER TABLE outcome_monitoring.governed_outcome_verdicts ADD CONSTRAINT om_verdict_reason CHECK (reason_code IN (
  'NO_DEFINITION','NOTHING_APPLIED','SCOPE_MISMATCH','WINDOW_OPEN','SOURCE_UNAVAILABLE',
  'BASELINE_MISSING','INSUFFICIENT_DATA','DATA_QUALITY','ATTRIBUTION_UNAVAILABLE','CONFOUNDED','MEASURED'));
INSERT INTO _migrations (filename) VALUES ('0216_add_governed_confounder_reason.sql') ON CONFLICT (filename) DO NOTHING;
COMMIT;
