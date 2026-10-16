-- Migration: 0201_enforce_om_monitored_action_child_scope_integrity
-- F-NA05-4 (follows F-NA05-3 / migration 0200): the append-only child tables of a monitored action must carry the SAME tenant, workspace and
-- business as the monitored action they describe.
--
-- DEFECT. monitored_action_versions and monitored_action_status_history (0109) each hold their own tenant_id / workspace_id / business_id (all NOT NULL,
-- each with its own single-column foreign key) and a monitored_action_id that references monitored_actions(id) ONLY. PostgreSQL performs foreign-key
-- checks as the owner of the referenced table, so they are not subject to row-level security: a writer could attach a version or a status-history row
-- of its own scope to a monitored action of another business, workspace or tenant. The only application writer (MonitoredActionRepository) writes
-- consistent scope, so this is a defence-in-depth gap, not a known exploit path; it is closed here for every writer, as 0200 did for observations.
--
-- CHANGE (additive; no column, row, policy, trigger or grant is changed; the existing single-column foreign keys are KEPT):
--   monitored_action_versions_monitored_action_scope_fkey         FOREIGN KEY (monitored_action_id, tenant_id, workspace_id, business_id)
--   monitored_action_status_history_monitored_action_scope_fkey   FOREIGN KEY (monitored_action_id, tenant_id, workspace_id, business_id)
--   both -> outcome_monitoring.monitored_actions (id, tenant_id, workspace_id, business_id), the referenced key monitored_actions_scope_key created by 0200
--   (this migration REFUSES to run if that key is missing: it never creates it, so ordering 0200 -> 0201 is enforced, not assumed).
--   ON DELETE RESTRICT (as the existing keys), default MATCH SIMPLE; all four columns are NOT NULL on both tables, so every row is always checked.
--
-- SAFETY.
--   * PRE-FLIGHT: before any DDL, violating rows (orphan or mismatched scope) are counted in both tables. If any exist the migration RAISES with the COUNTS
--     ONLY and rolls back: nothing is created and no historical row is read for content, changed or repaired.
--   * Each FK is added NOT VALID (no scan, brief lock) and then VALIDATEd in the same transaction (SHARE UPDATE EXCLUSIVE; writes continue).
--   * Both tables are append-only (forbid_mutation triggers); this migration issues no UPDATE or DELETE and does not touch those triggers. Idempotent guards.
--   * RLS is not changed or bypassed; no GRANT/REVOKE/role statement (grant-app-role.sh is unaffected: no new function or schema).
--
-- ROLLBACK (no data change):
--   ALTER TABLE outcome_monitoring.monitored_action_status_history DROP CONSTRAINT monitored_action_status_history_monitored_action_scope_fkey;
--   ALTER TABLE outcome_monitoring.monitored_action_versions       DROP CONSTRAINT monitored_action_versions_monitored_action_scope_fkey;
--   DELETE FROM _migrations WHERE filename = '0201_enforce_om_monitored_action_child_scope_integrity.sql';   -- only if the ledger entry must be removed
--
-- Not authorised here: production or staging application. No live migration is performed by this change.

BEGIN;

DO $$
DECLARE
  v_key_present boolean;
  v_ver_orphan bigint; v_ver_mismatch bigint; v_his_orphan bigint; v_his_mismatch bigint;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'monitored_actions_scope_key' AND conrelid = 'outcome_monitoring.monitored_actions'::regclass AND contype = 'u')
    INTO v_key_present;
  IF NOT v_key_present THEN
    RAISE EXCEPTION '0201 refused: migration 0200 (monitored_actions_scope_key) has not been applied. Apply 0200 first.' USING ERRCODE = 'undefined_object';
  END IF;

  SELECT count(*) INTO v_ver_orphan FROM outcome_monitoring.monitored_action_versions c
    WHERE NOT EXISTS (SELECT 1 FROM outcome_monitoring.monitored_actions a WHERE a.id = c.monitored_action_id);
  SELECT count(*) INTO v_ver_mismatch FROM outcome_monitoring.monitored_action_versions c
    JOIN outcome_monitoring.monitored_actions a ON a.id = c.monitored_action_id
    WHERE (c.tenant_id, c.workspace_id, c.business_id) IS DISTINCT FROM (a.tenant_id, a.workspace_id, a.business_id);
  SELECT count(*) INTO v_his_orphan FROM outcome_monitoring.monitored_action_status_history c
    WHERE NOT EXISTS (SELECT 1 FROM outcome_monitoring.monitored_actions a WHERE a.id = c.monitored_action_id);
  SELECT count(*) INTO v_his_mismatch FROM outcome_monitoring.monitored_action_status_history c
    JOIN outcome_monitoring.monitored_actions a ON a.id = c.monitored_action_id
    WHERE (c.tenant_id, c.workspace_id, c.business_id) IS DISTINCT FROM (a.tenant_id, a.workspace_id, a.business_id);
  IF v_ver_orphan + v_ver_mismatch + v_his_orphan + v_his_mismatch > 0 THEN
    RAISE EXCEPTION '0201 refused: existing monitored-action child rows violate scope (versions orphan=%, mismatch=%; status history orphan=%, mismatch=%). Nothing was changed. Obtain an owner-authorised remediation first.',
      v_ver_orphan, v_ver_mismatch, v_his_orphan, v_his_mismatch
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'monitored_action_versions_monitored_action_scope_fkey' AND conrelid = 'outcome_monitoring.monitored_action_versions'::regclass) THEN
    ALTER TABLE outcome_monitoring.monitored_action_versions
      ADD CONSTRAINT monitored_action_versions_monitored_action_scope_fkey
      FOREIGN KEY (monitored_action_id, tenant_id, workspace_id, business_id)
      REFERENCES outcome_monitoring.monitored_actions (id, tenant_id, workspace_id, business_id) ON DELETE RESTRICT NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'monitored_action_status_history_monitored_action_scope_fkey' AND conrelid = 'outcome_monitoring.monitored_action_status_history'::regclass) THEN
    ALTER TABLE outcome_monitoring.monitored_action_status_history
      ADD CONSTRAINT monitored_action_status_history_monitored_action_scope_fkey
      FOREIGN KEY (monitored_action_id, tenant_id, workspace_id, business_id)
      REFERENCES outcome_monitoring.monitored_actions (id, tenant_id, workspace_id, business_id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;

ALTER TABLE outcome_monitoring.monitored_action_versions VALIDATE CONSTRAINT monitored_action_versions_monitored_action_scope_fkey;
ALTER TABLE outcome_monitoring.monitored_action_status_history VALIDATE CONSTRAINT monitored_action_status_history_monitored_action_scope_fkey;

COMMENT ON CONSTRAINT monitored_action_versions_monitored_action_scope_fkey ON outcome_monitoring.monitored_action_versions IS
  'F-NA05-4: a version can only describe a monitored action of its own tenant, workspace and business, independently of row-level security (FK checks bypass RLS).';
COMMENT ON CONSTRAINT monitored_action_status_history_monitored_action_scope_fkey ON outcome_monitoring.monitored_action_status_history IS
  'F-NA05-4: a status-history row can only belong to a monitored action of its own tenant, workspace and business, independently of row-level security (FK checks bypass RLS).';

INSERT INTO _migrations (filename) VALUES ('0201_enforce_om_monitored_action_child_scope_integrity.sql')
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
