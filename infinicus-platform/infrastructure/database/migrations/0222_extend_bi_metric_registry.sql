-- BI-2-DEV-02: persistence for the governed BI-09 metric and KPI registry. Forward-only and additive over the Stage 2D tables
-- (0039 metric_definitions / metric_definition_versions), which stay the one registry: calculated values (metric_calculated_values) and the AC-2 evidence
-- path already reference them, so a second registry would drift. No table is created, dropped or renamed, and no existing row is changed.
--
--  * metric_definition_versions gains the governed snapshot of a definition: the canonical content (definition_content), its SHA-256 (content_hash), the
--    warehouse dataset it is defined on (warehouse_dataset_id) and a generated governance_status read from the snapshot (so it cannot disagree with it).
--    Rows written before this migration have no snapshot (all three NULL) and keep working exactly as before.
--  * aggregation_method may now be NULL: derived, ratio, rate and target metrics have no aggregation in the frozen BI-09 model. time_grain also allows the
--    frozen default 'all_time'. Every value already accepted stays accepted.
--  * Integrity in the database, not only in the service: a governed version must sit in the same tenant, workspace and business as its definition and its
--    dataset, must be exactly the next version, and a definition that has governed versions cannot take an ungoverned one. A definition's code and scope
--    cannot be changed once created (the code is the identity other layers use).
-- Rollback (development only, never after governed rows exist in a shared environment): DROP TRIGGER check_metric_definition_version_scope ON
-- business_intelligence.metric_definition_versions; DROP TRIGGER forbid_metric_definition_identity_change ON business_intelligence.metric_definitions; DROP FUNCTION
-- business_intelligence.check_metric_definition_version_scope(); DROP FUNCTION business_intelligence.forbid_metric_definition_identity_change(); then drop the
-- added columns and constraints below and restore the two original CHECKs and the NOT NULL on aggregation_method.
BEGIN;

ALTER TABLE business_intelligence.metric_definition_versions
  ADD COLUMN warehouse_dataset_id uuid REFERENCES business_intelligence.analytical_datasets(id) ON DELETE RESTRICT,
  ADD COLUMN definition_content   jsonb CHECK (definition_content IS NULL OR jsonb_typeof(definition_content) = 'object'),
  ADD COLUMN content_hash         text  CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN governance_status    text  GENERATED ALWAYS AS (definition_content ->> 'governanceStatus') STORED;

ALTER TABLE business_intelligence.metric_definition_versions
  ADD CONSTRAINT metric_definition_versions_snapshot_complete CHECK (
    (definition_content IS NULL AND content_hash IS NULL AND warehouse_dataset_id IS NULL)
    OR (definition_content IS NOT NULL AND content_hash IS NOT NULL AND warehouse_dataset_id IS NOT NULL
        AND warehouse_dataset_id::text = definition_content ->> 'warehouseDatasetId'
        AND char_length(definition_content ->> 'governanceStatus') BETWEEN 1 AND 64
        AND version_number = (definition_content ->> 'version')::integer)
  );

ALTER TABLE business_intelligence.metric_definition_versions ALTER COLUMN aggregation_method DROP NOT NULL;

ALTER TABLE business_intelligence.metric_definition_versions DROP CONSTRAINT metric_definition_versions_time_grain_check;
ALTER TABLE business_intelligence.metric_definition_versions
  ADD CONSTRAINT metric_definition_versions_time_grain_check CHECK (time_grain IN ('day','week','month','quarter','year','all_time'));

CREATE INDEX idx_bi_metric_definition_versions_warehouse_dataset_id
  ON business_intelligence.metric_definition_versions (warehouse_dataset_id) WHERE warehouse_dataset_id IS NOT NULL;

-- ── a governed version stays inside its definition's and its dataset's scope, and follows the version chain ──────────────────────────────────────────

CREATE OR REPLACE FUNCTION business_intelligence.check_metric_definition_version_scope()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  def business_intelligence.metric_definitions%ROWTYPE;
  ds  business_intelligence.analytical_datasets%ROWTYPE;
BEGIN
  SELECT * INTO def FROM business_intelligence.metric_definitions WHERE id = NEW.metric_definition_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'metric definition % does not exist', NEW.metric_definition_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF def.tenant_id <> NEW.tenant_id OR def.workspace_id <> NEW.workspace_id OR def.business_id <> NEW.business_id THEN
    RAISE EXCEPTION 'metric definition version scope does not match its definition' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.definition_content IS NULL THEN
    IF EXISTS (SELECT 1 FROM business_intelligence.metric_definition_versions v WHERE v.metric_definition_id = NEW.metric_definition_id AND v.definition_content IS NOT NULL) THEN
      RAISE EXCEPTION 'a governed metric definition cannot take an ungoverned version' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO ds FROM business_intelligence.analytical_datasets WHERE id = NEW.warehouse_dataset_id;
  IF NOT FOUND OR ds.tenant_id <> NEW.tenant_id OR ds.workspace_id <> NEW.workspace_id OR ds.business_id <> NEW.business_id THEN
    RAISE EXCEPTION 'metric definition version dataset is not in the definition scope' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.version_number <> def.latest_version + 1 THEN
    RAISE EXCEPTION 'metric definition version must be %, not %', def.latest_version + 1, NEW.version_number USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER check_metric_definition_version_scope
  BEFORE INSERT ON business_intelligence.metric_definition_versions
  FOR EACH ROW EXECUTE FUNCTION business_intelligence.check_metric_definition_version_scope();

-- ── identity and scope of a definition never change ─────────────────────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION business_intelligence.forbid_metric_definition_identity_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.metric_code <> OLD.metric_code OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.workspace_id <> OLD.workspace_id OR NEW.business_id <> OLD.business_id THEN
    RAISE EXCEPTION 'metric definition identity (id, code, tenant, workspace, business) cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.latest_version < OLD.latest_version THEN
    RAISE EXCEPTION 'metric definition latest_version cannot go backwards' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER forbid_metric_definition_identity_change
  BEFORE UPDATE ON business_intelligence.metric_definitions
  FOR EACH ROW EXECUTE FUNCTION business_intelligence.forbid_metric_definition_identity_change();

INSERT INTO _migrations (filename) VALUES ('0222_extend_bi_metric_registry.sql')
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
