-- Migration: 0200_enforce_om_monitored_action_scope_integrity
-- F-NA05-3 (database-level hardening after F-NA05-1 / F-NA05-2): a row that names a monitored action must name one OF ITS OWN
-- tenant, workspace and business.
--
-- DEFECT. outcome_observations.monitored_action_id (0110) and action_execution_verifications.monitored_action_id (0194) reference
-- monitored_actions(id) only. A foreign-key check is performed by PostgreSQL as the owner of the referenced table, so it is NOT subject to
-- row-level security: a writer could point a row at a monitored action it cannot even read - another business, workspace or tenant.
-- F-NA05-1 closed the application path (DecisionWorkflowService.recordOutcome); this migration closes the database path for every writer.
--
-- CHANGE (additive; no column, row, policy, trigger or grant is changed; existing single-column foreign keys are KEPT):
--   1. monitored_actions_scope_key  UNIQUE (id, tenant_id, workspace_id, business_id)       - the referenced key of the composite FKs.
--   2. outcome_observations_monitored_action_scope_fkey
--        FOREIGN KEY (monitored_action_id, tenant_id, workspace_id, business_id) -> monitored_actions(id, tenant_id, workspace_id, business_id)
--   3. action_execution_verifications_monitored_action_scope_fkey  (same columns).
--   Both FKs are ON DELETE RESTRICT, matching the existing FKs. Default MATCH SIMPLE: a row whose monitored_action_id IS NULL is not checked
--   (action_execution_verifications.monitored_action_id is nullable by design - an execution fact may not map to a monitored action); tenant_id,
--   workspace_id and business_id are NOT NULL on both tables, so NULL in the reference column is the only way to skip the check, and
--   outcome_observations.monitored_action_id is NOT NULL. A non-null id must match the exact (tenant, workspace, business) triple or the write fails (23503).
--
-- SAFETY.
--   * PRE-FLIGHT: before any DDL the migration counts violating rows (orphan or mismatched scope). If any exist it RAISES with the COUNTS ONLY
--     (no ids, no content) and the whole transaction rolls back: nothing is created, nothing is rewritten. Historical rows are never repaired here.
--   * Each FK is added NOT VALID (no table scan, brief lock) and then VALIDATEd in the same transaction (SHARE UPDATE EXCLUSIVE, writes continue).
--     A violating row would therefore also abort the migration at VALIDATE. Re-running is a no-op (idempotent guards on constraint names).
--   * The unique constraint builds an index under a short ACCESS EXCLUSIVE lock on monitored_actions; the table is small (production: 3 rows at 2026-10-16).
--   * RLS is not changed and not bypassed; no trigger is disabled; no GRANT/REVOKE/role statement (grant-app-role.sh is unaffected: no new function or schema).
--
-- ROLLBACK (no data change either way):
--   ALTER TABLE outcome_monitoring.action_execution_verifications DROP CONSTRAINT action_execution_verifications_monitored_action_scope_fkey;
--   ALTER TABLE outcome_monitoring.outcome_observations           DROP CONSTRAINT outcome_observations_monitored_action_scope_fkey;
--   ALTER TABLE outcome_monitoring.monitored_actions              DROP CONSTRAINT monitored_actions_scope_key;
--   DELETE FROM _migrations WHERE filename = '0200_enforce_om_monitored_action_scope_integrity.sql';   -- only if the ledger entry must be removed
--
-- Not authorised here: production or staging application. No live migration is performed by this change.

BEGIN;

DO $$
DECLARE
  v_obs_orphan bigint; v_obs_mismatch bigint; v_ver_orphan bigint; v_ver_mismatch bigint;
BEGIN
  SELECT count(*) INTO v_obs_orphan FROM outcome_monitoring.outcome_observations o
    WHERE NOT EXISTS (SELECT 1 FROM outcome_monitoring.monitored_actions a WHERE a.id = o.monitored_action_id);
  SELECT count(*) INTO v_obs_mismatch FROM outcome_monitoring.outcome_observations o
    JOIN outcome_monitoring.monitored_actions a ON a.id = o.monitored_action_id
    WHERE (o.tenant_id, o.workspace_id, o.business_id) IS DISTINCT FROM (a.tenant_id, a.workspace_id, a.business_id);
  SELECT count(*) INTO v_ver_orphan FROM outcome_monitoring.action_execution_verifications x
    WHERE x.monitored_action_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM outcome_monitoring.monitored_actions a WHERE a.id = x.monitored_action_id);
  SELECT count(*) INTO v_ver_mismatch FROM outcome_monitoring.action_execution_verifications x
    JOIN outcome_monitoring.monitored_actions a ON a.id = x.monitored_action_id
    WHERE (x.tenant_id, x.workspace_id, x.business_id) IS DISTINCT FROM (a.tenant_id, a.workspace_id, a.business_id);
  IF v_obs_orphan + v_obs_mismatch + v_ver_orphan + v_ver_mismatch > 0 THEN
    RAISE EXCEPTION '0200 refused: existing outcome-monitoring rows violate monitored-action scope (observations orphan=%, mismatch=%; execution verifications orphan=%, mismatch=%). Nothing was changed. Run docs/architecture/reconciliation/production-discovery/f-na05-2-om-integrity-audit.sql and obtain an owner-authorised remediation first.',
      v_obs_orphan, v_obs_mismatch, v_ver_orphan, v_ver_mismatch
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'monitored_actions_scope_key' AND conrelid = 'outcome_monitoring.monitored_actions'::regclass) THEN
    ALTER TABLE outcome_monitoring.monitored_actions
      ADD CONSTRAINT monitored_actions_scope_key UNIQUE (id, tenant_id, workspace_id, business_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'outcome_observations_monitored_action_scope_fkey' AND conrelid = 'outcome_monitoring.outcome_observations'::regclass) THEN
    ALTER TABLE outcome_monitoring.outcome_observations
      ADD CONSTRAINT outcome_observations_monitored_action_scope_fkey
      FOREIGN KEY (monitored_action_id, tenant_id, workspace_id, business_id)
      REFERENCES outcome_monitoring.monitored_actions (id, tenant_id, workspace_id, business_id) ON DELETE RESTRICT NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'action_execution_verifications_monitored_action_scope_fkey' AND conrelid = 'outcome_monitoring.action_execution_verifications'::regclass) THEN
    ALTER TABLE outcome_monitoring.action_execution_verifications
      ADD CONSTRAINT action_execution_verifications_monitored_action_scope_fkey
      FOREIGN KEY (monitored_action_id, tenant_id, workspace_id, business_id)
      REFERENCES outcome_monitoring.monitored_actions (id, tenant_id, workspace_id, business_id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;

ALTER TABLE outcome_monitoring.outcome_observations VALIDATE CONSTRAINT outcome_observations_monitored_action_scope_fkey;
ALTER TABLE outcome_monitoring.action_execution_verifications VALIDATE CONSTRAINT action_execution_verifications_monitored_action_scope_fkey;

COMMENT ON CONSTRAINT monitored_actions_scope_key ON outcome_monitoring.monitored_actions IS
  'F-NA05-3: referenced key of the composite scope foreign keys. id is already unique; this adds the scope triple so a referencing row must match tenant, workspace and business.';
COMMENT ON CONSTRAINT outcome_observations_monitored_action_scope_fkey ON outcome_monitoring.outcome_observations IS
  'F-NA05-3: an observation can only reference a monitored action of its own tenant, workspace and business, independently of row-level security (FK checks bypass RLS).';
COMMENT ON CONSTRAINT action_execution_verifications_monitored_action_scope_fkey ON outcome_monitoring.action_execution_verifications IS
  'F-NA05-3: when monitored_action_id is not null it must reference a monitored action of the same tenant, workspace and business (MATCH SIMPLE: a NULL reference is not checked).';

INSERT INTO _migrations (filename) VALUES ('0200_enforce_om_monitored_action_scope_integrity.sql')
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
