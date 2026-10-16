-- F-NA05-2: Outcome Monitoring historical scope-integrity audit (STRICTLY READ-ONLY).
-- Question answered: does any outcome observation reference a monitored action of another business, workspace or tenant?
-- (Before PR #144 the API accepted such a reference: the database FK binds only monitored_actions(id).)
--
-- RUN BY THE OWNER on the production VM (deploy user, from the directory holding docker-compose.yml). Review it first. Example:
--   docker compose exec -T -e PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=30000 -c lock_timeout=2000' \
--     postgres psql -X -v ON_ERROR_STOP=1 -U admin_role -d infinicus < f-na05-2-om-integrity-audit.sql | tee "f-na05-2-$(date -u +%Y%m%dT%H%M%SZ).txt"
-- Guarantees: SELECT only (no DDL/DML/GRANT); the session is forced read-only; output is aggregate counts, catalog definitions and at most 20
-- irreversible 12-hex fingerprints. No names, summaries, payloads, tokens or connection strings are printed.
-- Interpretation: every check named C0x/C09x must be 0 for a clean result; any non-zero count is reported for separate owner review. Zero rows
-- does not prove other environments are clean. The first row (identity) must show the intended database and read_only = on before trusting the rest.
\set QUIET on
\pset format aligned
SELECT 'identity' AS check, current_database() AS db, current_setting('server_version') AS pg, current_setting('transaction_read_only') AS read_only, (SELECT max(filename) FROM _migrations) AS migration_head;

-- 1 population
SELECT 'C01 observations total' AS check, count(*) AS n FROM outcome_monitoring.outcome_observations;
SELECT 'C01b observations by status' AS check, status, count(*) AS n FROM outcome_monitoring.outcome_observations GROUP BY status ORDER BY status;
SELECT 'C01c monitored_actions total' AS check, count(*) AS n FROM outcome_monitoring.monitored_actions;

-- 2 orphans (should be impossible while the FK exists)
SELECT 'C02 observation -> missing monitored action' AS check, count(*) AS n
  FROM outcome_monitoring.outcome_observations o LEFT JOIN outcome_monitoring.monitored_actions a ON a.id = o.monitored_action_id WHERE a.id IS NULL;

-- 3-5 observation vs its monitored action
SELECT 'C03 business mismatch'  AS check, count(*) AS n FROM outcome_monitoring.outcome_observations o JOIN outcome_monitoring.monitored_actions a ON a.id = o.monitored_action_id WHERE o.business_id  IS DISTINCT FROM a.business_id;
SELECT 'C04 tenant mismatch'    AS check, count(*) AS n FROM outcome_monitoring.outcome_observations o JOIN outcome_monitoring.monitored_actions a ON a.id = o.monitored_action_id WHERE o.tenant_id    IS DISTINCT FROM a.tenant_id;
SELECT 'C05 workspace mismatch' AS check, count(*) AS n FROM outcome_monitoring.outcome_observations o JOIN outcome_monitoring.monitored_actions a ON a.id = o.monitored_action_id WHERE o.workspace_id IS DISTINCT FROM a.workspace_id;
SELECT 'C03-05 any mismatch (distinct rows)' AS check, count(*) AS n FROM outcome_monitoring.outcome_observations o JOIN outcome_monitoring.monitored_actions a ON a.id = o.monitored_action_id
  WHERE (o.business_id, o.tenant_id, o.workspace_id) IS DISTINCT FROM (a.business_id, a.tenant_id, a.workspace_id);

-- 6 observation's own scope vs the business / workspace it names
SELECT 'C06a observation business missing or in other tenant/workspace' AS check, count(*) AS n
  FROM outcome_monitoring.outcome_observations o LEFT JOIN platform.businesses b ON b.id = o.business_id
 WHERE b.id IS NULL OR b.tenant_id IS DISTINCT FROM o.tenant_id OR b.workspace_id IS DISTINCT FROM o.workspace_id;
SELECT 'C06b observation workspace not in its tenant' AS check, count(*) AS n
  FROM outcome_monitoring.outcome_observations o LEFT JOIN tenancy.workspaces w ON w.id = o.workspace_id
 WHERE w.id IS NULL OR w.tenant_id IS DISTINCT FROM o.tenant_id;
SELECT 'C06c monitored action business/workspace inconsistent' AS check, count(*) AS n
  FROM outcome_monitoring.monitored_actions a LEFT JOIN platform.businesses b ON b.id = a.business_id
 WHERE b.id IS NULL OR b.tenant_id IS DISTINCT FROM a.tenant_id OR b.workspace_id IS DISTINCT FROM a.workspace_id;

-- 7 parent action's business soft-deleted / not active (inaccessible under the expected scope)
SELECT 'C07 observation whose parent action business is not active' AS check, count(*) AS n
  FROM outcome_monitoring.outcome_observations o JOIN outcome_monitoring.monitored_actions a ON a.id = o.monitored_action_id JOIN platform.businesses b ON b.id = a.business_id
 WHERE b.status <> 'active';

-- 9 children of observations: versions / measurements / evidence scope equals their parent's
SELECT 'C09a versions scope != observation scope' AS check, count(*) AS n
  FROM outcome_monitoring.outcome_observation_versions v JOIN outcome_monitoring.outcome_observations o ON o.id = v.observation_id
 WHERE (v.tenant_id, v.workspace_id, v.business_id) IS DISTINCT FROM (o.tenant_id, o.workspace_id, o.business_id);
SELECT 'C09b measurements scope != version scope' AS check, count(*) AS n
  FROM outcome_monitoring.outcome_measurements m JOIN outcome_monitoring.outcome_observation_versions v ON v.id = m.observation_version_id
 WHERE (m.tenant_id, m.workspace_id, m.business_id) IS DISTINCT FROM (v.tenant_id, v.workspace_id, v.business_id);
SELECT 'C09c evidence scope != version scope' AS check, count(*) AS n
  FROM outcome_monitoring.outcome_evidence e JOIN outcome_monitoring.outcome_observation_versions v ON v.id = e.observation_version_id
 WHERE (e.tenant_id, e.workspace_id, e.business_id) IS DISTINCT FROM (v.tenant_id, v.workspace_id, v.business_id);
SELECT 'C09d observations with no version row' AS check, count(*) AS n
  FROM outcome_monitoring.outcome_observations o WHERE NOT EXISTS (SELECT 1 FROM outcome_monitoring.outcome_observation_versions v WHERE v.observation_id = o.id);
SELECT 'C09e action_execution_verifications.monitored_action_id scope mismatch' AS check, count(*) AS n
  FROM outcome_monitoring.action_execution_verifications x JOIN outcome_monitoring.monitored_actions a ON a.id = x.monitored_action_id
 WHERE (x.tenant_id, x.workspace_id, x.business_id) IS DISTINCT FROM (a.tenant_id, a.workspace_id, a.business_id);
SELECT 'C09f downstream rows (breaches/alerts/attribution/reviews) scope != observation scope' AS check,
  (SELECT count(*) FROM outcome_monitoring.threshold_breaches r JOIN outcome_monitoring.outcome_observations o ON o.id=r.observation_id WHERE (r.tenant_id,r.workspace_id,r.business_id) IS DISTINCT FROM (o.tenant_id,o.workspace_id,o.business_id)) AS breaches,
  (SELECT count(*) FROM outcome_monitoring.monitoring_alerts r JOIN outcome_monitoring.outcome_observations o ON o.id=r.observation_id WHERE (r.tenant_id,r.workspace_id,r.business_id) IS DISTINCT FROM (o.tenant_id,o.workspace_id,o.business_id)) AS alerts,
  (SELECT count(*) FROM outcome_monitoring.outcome_attribution_runs r JOIN outcome_monitoring.outcome_observations o ON o.id=r.observation_id WHERE (r.tenant_id,r.workspace_id,r.business_id) IS DISTINCT FROM (o.tenant_id,o.workspace_id,o.business_id)) AS attribution,
  (SELECT count(*) FROM outcome_monitoring.outcome_reviews r JOIN outcome_monitoring.outcome_observations o ON o.id=r.observation_id WHERE (r.tenant_id,r.workspace_id,r.business_id) IS DISTINCT FROM (o.tenant_id,o.workspace_id,o.business_id)) AS reviews;

-- Bounded sanitised fingerprints of any mismatching observation (irreversible, first 12 hex of sha256; max 20 rows; no names/summaries)
SELECT 'F01 mismatching observation fingerprints (max 20)' AS check,
       left(encode(sha256(o.id::text::bytea),'hex'),12) AS obs_fp, o.created_at::date AS created_on,
       (o.tenant_id <> a.tenant_id) AS tenant_diff, (o.workspace_id <> a.workspace_id) AS ws_diff, (o.business_id <> a.business_id) AS biz_diff
  FROM outcome_monitoring.outcome_observations o JOIN outcome_monitoring.monitored_actions a ON a.id = o.monitored_action_id
 WHERE (o.business_id, o.tenant_id, o.workspace_id) IS DISTINCT FROM (a.business_id, a.tenant_id, a.workspace_id)
 ORDER BY o.created_at LIMIT 20;

-- 8 catalog: which constraints exist on the OM link (does any FK/trigger/check bind the scope columns together?)
SELECT 'K01 constraints on outcome_observations' AS check, conname, contype, pg_get_constraintdef(oid) AS def
  FROM pg_constraint WHERE conrelid = 'outcome_monitoring.outcome_observations'::regclass ORDER BY contype, conname;
SELECT 'K02 non-internal triggers on outcome_observations' AS check, tgname, pg_get_triggerdef(oid) AS def
  FROM pg_trigger WHERE tgrelid = 'outcome_monitoring.outcome_observations'::regclass AND NOT tgisinternal ORDER BY tgname;
SELECT 'K03 unique constraints on monitored_actions (composite FK targets)' AS check, conname, pg_get_constraintdef(oid) AS def
  FROM pg_constraint WHERE conrelid = 'outcome_monitoring.monitored_actions'::regclass AND contype IN ('p','u') ORDER BY conname;
SELECT 'K04 RLS flags' AS check, relname, relrowsecurity AS rls, relforcerowsecurity AS forced
  FROM pg_class WHERE oid IN ('outcome_monitoring.outcome_observations'::regclass,'outcome_monitoring.monitored_actions'::regclass);

-- 10 timeline for exposure: first/last observation per month (counts only)
SELECT 'T01 observations by creation month' AS check, to_char(date_trunc('month', created_at),'YYYY-MM') AS month, count(*) AS n FROM outcome_monitoring.outcome_observations GROUP BY 2 ORDER BY 2;
