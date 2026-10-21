-- OM-EVID-1: Outcome Monitoring evidence against Guardrail Section XI ("the action executed" is not "the action worked"). STRICTLY READ-ONLY.
-- Question answered: is every OM verification a verification of a real, untampered BO execution; does any row claim an outcome beyond
-- PENDING / INCONCLUSIVE; is any BO execution still unverified by OM; and has anything reached Continuous Learning?
--
-- RUN BY THE OWNER (never by Claude) on the target database, reviewed first. Example for the production VM (deploy user, directory holding docker-compose.yml):
--   docker compose exec -T -e PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=30000 -c lock_timeout=2000' \
--     postgres psql -X -v ON_ERROR_STOP=1 -U admin_role -d infinicus < om-evid-1-section-xi-evidence.sql | tee "om-evid-1-$(date -u +%Y%m%dT%H%M%SZ).txt"
-- Guarantees: SELECT only (no DDL/DML/GRANT); the session is forced read-only; output is aggregate counts and catalog definitions. No names, summaries,
-- payloads, evidence documents, tokens or connection strings are printed. It reads Business Operations tables because it is an owner audit run with an
-- administrative role; the application's OM code never does (guarded by tests).
-- Requires migrations through 0194 (verifications) and 0191 (BO executions). If a relation is missing the script stops at that check: report it.
-- Interpretation (a clean result for the P0-6 programme):
--   X03a, X03b, X04, X05, X06a-X06e, X09b must all be 0.
--   X07 (BO executions with no OM verification) must be 0 for rows older than a few minutes; a non-zero old count means the OM consumer is not
--       verifying (worker absent, dead-lettered events) and those executions are UNVERIFIED, not "successful".
--   X10 packages 'ready' / 'published' and X11 must be 0 while nothing may learn (Guardrail Section XII).
-- The first row (identity) must show the intended database and read_only = on before trusting the rest.
\set QUIET on
\pset format aligned
SELECT 'identity' AS check, current_database() AS db, current_setting('server_version') AS pg, current_setting('transaction_read_only') AS read_only, (SELECT max(filename) FROM _migrations) AS migration_head;

-- 1 population of OM execution verifications (the only place OM states an execution was verified)
SELECT 'X01 verifications total' AS check, count(*) AS n FROM outcome_monitoring.action_execution_verifications;
SELECT 'X02 verifications by state' AS check, execution_state, outcome_state, execution_outcome, mutation_result, count(*) AS n
  FROM outcome_monitoring.action_execution_verifications GROUP BY 2, 3, 4, 5 ORDER BY 2, 3, 4, 5;

-- 2 Section XI: nothing beyond execution verification and PENDING / INCONCLUSIVE (the CHECK constraints make these impossible; 0 proves none slipped in
--   through a replica, a restore or a disabled constraint)
SELECT 'X03a outcome_state beyond PENDING/INCONCLUSIVE' AS check, count(*) AS n
  FROM outcome_monitoring.action_execution_verifications WHERE outcome_state NOT IN ('OUTCOME_PENDING', 'OUTCOME_INCONCLUSIVE');
SELECT 'X03b execution_state other than EXECUTION_VERIFIED' AS check, count(*) AS n
  FROM outcome_monitoring.action_execution_verifications WHERE execution_state <> 'EXECUTION_VERIFIED';
SELECT 'X04 PENDING without a SUCCEEDED+APPLIED execution' AS check, count(*) AS n
  FROM outcome_monitoring.action_execution_verifications WHERE outcome_state = 'OUTCOME_PENDING' AND NOT (execution_outcome = 'SUCCEEDED' AND mutation_result = 'APPLIED');
SELECT 'X03c the constraints that enforce it (catalog)' AS check, conname, convalidated, pg_get_constraintdef(oid) AS definition
  FROM pg_constraint WHERE conrelid = 'outcome_monitoring.action_execution_verifications'::regclass AND contype = 'c'
   AND conname ~ 'outcome_state|execution_state|pending_needs_applied|outcome_shape' ORDER BY conname;
SELECT 'X03d append-only and tenant isolation (catalog)' AS check,
       (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'outcome_monitoring.action_execution_verifications'::regclass AND NOT tgisinternal AND tgname ~ '^forbid_') AS forbid_triggers_expected_2,
       (SELECT relforcerowsecurity FROM pg_class WHERE oid = 'outcome_monitoring.action_execution_verifications'::regclass) AS rls_forced;

-- 3 every verification refers to a real BO execution, and agrees with it (tamper / substitution detection)
SELECT 'X05 verification -> missing BO execution' AS check, count(*) AS n
  FROM outcome_monitoring.action_execution_verifications v
  LEFT JOIN business_operations.authorized_action_executions e ON e.id = v.execution_id AND e.business_id = v.business_id
 WHERE e.id IS NULL;
SELECT 'X06a digest differs from BO evidence digest' AS check, count(*) AS n
  FROM outcome_monitoring.action_execution_verifications v JOIN business_operations.authorized_action_executions e ON e.id = v.execution_id AND e.business_id = v.business_id
 WHERE v.evidence_digest <> e.evidence_digest;
SELECT 'X06b execution outcome differs' AS check, count(*) AS n
  FROM outcome_monitoring.action_execution_verifications v JOIN business_operations.authorized_action_executions e ON e.id = v.execution_id AND e.business_id = v.business_id
 WHERE v.execution_outcome <> e.outcome;
SELECT 'X06c mutation result differs' AS check, count(*) AS n
  FROM outcome_monitoring.action_execution_verifications v JOIN business_operations.authorized_action_executions e ON e.id = v.execution_id AND e.business_id = v.business_id
 WHERE v.mutation_result <> e.mutation_result;
SELECT 'X06d package/claim/target differs' AS check, count(*) AS n
  FROM outcome_monitoring.action_execution_verifications v JOIN business_operations.authorized_action_executions e ON e.id = v.execution_id AND e.business_id = v.business_id
 WHERE (v.package_id, v.package_version, v.claim_id, v.target_kind, v.target_id) IS DISTINCT FROM (e.package_id, e.package_version, e.claim_id, e.target_kind, e.target_id);
SELECT 'X06e scope differs (tenant/workspace)' AS check, count(*) AS n
  FROM outcome_monitoring.action_execution_verifications v JOIN business_operations.authorized_action_executions e ON e.id = v.execution_id AND e.business_id = v.business_id
 WHERE (v.tenant_id, v.workspace_id) IS DISTINCT FROM (e.tenant_id, e.workspace_id);

-- 4 executions that OM has NOT verified (unverified is not successful). Age buckets use the execution's recorded time.
SELECT 'X07 BO executions without an OM verification, by age and outcome' AS check,
       CASE WHEN e.recorded_at > now() - interval '5 minutes' THEN '<5m' WHEN e.recorded_at > now() - interval '1 hour' THEN '5m-1h' ELSE '>1h' END AS age,
       e.outcome, e.mutation_result, count(*) AS n
  FROM business_operations.authorized_action_executions e
 WHERE NOT EXISTS (SELECT 1 FROM outcome_monitoring.action_execution_verifications v WHERE v.execution_id = e.id AND v.business_id = e.business_id)
 GROUP BY 2, 3, 4 ORDER BY 2, 3, 4;
SELECT 'X08 executed-event delivery state (counts only)' AS check, status, count(*) AS n
  FROM events.outbox_events WHERE event_type = 'operations.action.executed' GROUP BY status ORDER BY status;
SELECT 'X08b OM consumer inbox by status' AS check, status, count(*) AS n
  FROM events.inbox_events WHERE event_type = 'operations.action.executed' GROUP BY status ORDER BY status;

-- 5 the older, human-entered observation path is a different thing and must not be mistaken for a verified outcome
SELECT 'X09a observations by status' AS check, status, count(*) AS n FROM outcome_monitoring.outcome_observations GROUP BY status ORDER BY status;
SELECT 'X09b observations in status verified (nothing in the programme sets this; expected 0)' AS check, count(*) AS n
  FROM outcome_monitoring.outcome_observations WHERE status = 'verified';
SELECT 'X09c observations whose monitored action has no OM execution verification (manual outcomes, informational)' AS check, count(*) AS n
  FROM outcome_monitoring.outcome_observations o
 WHERE NOT EXISTS (SELECT 1 FROM outcome_monitoring.action_execution_verifications v WHERE v.monitored_action_id = o.monitored_action_id);
SELECT 'X09d observation evidence types' AS check, evidence_type, count(*) AS n FROM outcome_monitoring.outcome_evidence GROUP BY evidence_type ORDER BY evidence_type;

-- 6 nothing may learn yet (Guardrail Section XII)
SELECT 'X10 learning feedback packages by status (ready/published expected 0)' AS check, status, count(*) AS n FROM outcome_monitoring.learning_feedback_packages GROUP BY status ORDER BY status;
SELECT 'X11 OM publication packages targeting continuous_learning, and CL intake packages (both expected 0)' AS check,
       (SELECT count(*) FROM outcome_monitoring.om_publication_packages WHERE target_layer = 'continuous_learning') AS om_to_cl_publications,
       (SELECT count(*) FROM continuous_learning.cl_intake_packages) AS cl_intake_packages;
