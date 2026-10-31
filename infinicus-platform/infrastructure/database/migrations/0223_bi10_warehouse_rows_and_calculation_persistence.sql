-- BI-2-DEV-07: durable storage for governed BI-10 calculation. Forward-only and additive: five new tables and four scope keys on existing tables; no existing row,
-- column, trigger or policy is changed, and no existing table is dropped or renamed.
--
--  * warehouse_dataset_rows + warehouse_dataset_version_seals: BI-owned warehouse rows of a PUBLISHED dataset version. Dataset versions are append-only and are
--    created already published (IntakeDatasetRepository), carrying the record count Business Operations declared for the package, so "immutable published
--    evidence" cannot be a draft-to-published transition. Instead rows may be appended to a published version until it is SEALED: the seal is computed by the
--    database (row count, contiguity from 1, a digest of the row fingerprints in order), must equal the declared record count, and after it nothing can be added.
--    Every row must cite a source reference of the very intake package the version was built from. Rows, their fingerprints and the seal are append-only.
--  * metric_calculation_runs / _run_inputs / metric_results: the BI-10 calculation run (deterministic id, hand-off id, dataset fingerprints, source timestamp,
--    correlation, server-generated persisted time), the sealed dataset versions it read, and one row per metric result (canonical decimal value, definition
--    version and content hash, group, units, target and threshold status, source row count). Why metric_calculated_values is not used: it requires a value and a
--    period (no "no_data" result), stores floats from callers, and has no run, hand-off, group key or definition-hash columns.
--  * Integrity in the database: composite scope-aware foreign keys (tenant, workspace and business travel with every reference); a result must agree with the
--    stored definition version it cites (content hash, dataset, code, type); a run is complete or absent (deferred check: result and input counts, dataset
--    fingerprints, a dataset for every base metric); every table is append-only (update, delete and truncate refused) with forced row-level security.
-- Rollback (development only, never after rows exist in a shared environment): DROP TABLE business_intelligence.metric_results, metric_calculation_run_inputs,
-- metric_calculation_runs, warehouse_dataset_version_seals, warehouse_dataset_rows; DROP the functions created below; then drop the four *_scope_key constraints.
BEGIN;

-- ── scope keys on the parents (ids are already unique, so these only enable composite foreign keys) ─────────────────────────────────────────────────

ALTER TABLE business_intelligence.analytical_datasets
  ADD CONSTRAINT analytical_datasets_scope_key UNIQUE (id, tenant_id, workspace_id, business_id);
ALTER TABLE business_intelligence.analytical_dataset_versions
  ADD CONSTRAINT analytical_dataset_versions_dataset_scope_key UNIQUE (id, dataset_id, tenant_id, workspace_id, business_id);
ALTER TABLE business_intelligence.intelligence_source_references
  ADD CONSTRAINT intelligence_source_references_scope_key UNIQUE (id, tenant_id, workspace_id, business_id);
ALTER TABLE business_intelligence.metric_definition_versions
  ADD CONSTRAINT metric_definition_versions_scope_key UNIQUE (metric_definition_id, version_number, tenant_id, workspace_id, business_id);

-- ── warehouse rows ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

CREATE TABLE business_intelligence.warehouse_dataset_rows (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid        NOT NULL REFERENCES tenancy.tenants(id)     ON DELETE RESTRICT,
  workspace_id        uuid        NOT NULL REFERENCES tenancy.workspaces(id)  ON DELETE RESTRICT,
  business_id         uuid        NOT NULL REFERENCES platform.businesses(id) ON DELETE RESTRICT,
  dataset_id          uuid        NOT NULL,
  dataset_version_id  uuid        NOT NULL,
  row_number          integer     NOT NULL CHECK (row_number >= 1),
  row_data            jsonb       NOT NULL CHECK (jsonb_typeof(row_data) = 'object'),
  row_fingerprint     text        NOT NULL CHECK (row_fingerprint ~ '^[0-9a-f]{64}$'),
  source_reference_id uuid        NOT NULL,
  recorded_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT warehouse_dataset_rows_version_row_unique UNIQUE (dataset_version_id, row_number),
  CONSTRAINT warehouse_dataset_rows_version_fk FOREIGN KEY (dataset_version_id, dataset_id, tenant_id, workspace_id, business_id)
    REFERENCES business_intelligence.analytical_dataset_versions (id, dataset_id, tenant_id, workspace_id, business_id) ON DELETE RESTRICT,
  CONSTRAINT warehouse_dataset_rows_source_fk FOREIGN KEY (source_reference_id, tenant_id, workspace_id, business_id)
    REFERENCES business_intelligence.intelligence_source_references (id, tenant_id, workspace_id, business_id) ON DELETE RESTRICT
);
COMMENT ON TABLE business_intelligence.warehouse_dataset_rows IS
  'Append-only. Warehouse rows of a published dataset version, recorded only by the BI ingestion pathway and locked by the version seal. row_fingerprint is computed here (SHA-256 of the jsonb text), never taken from the caller.';

CREATE TABLE business_intelligence.warehouse_dataset_version_seals (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid        NOT NULL REFERENCES tenancy.tenants(id)     ON DELETE RESTRICT,
  workspace_id           uuid        NOT NULL REFERENCES tenancy.workspaces(id)  ON DELETE RESTRICT,
  business_id            uuid        NOT NULL REFERENCES platform.businesses(id) ON DELETE RESTRICT,
  dataset_id             uuid        NOT NULL,
  dataset_version_id     uuid        NOT NULL,
  row_count              integer     NOT NULL CHECK (row_count >= 0),
  declared_record_count  integer     NOT NULL CHECK (declared_record_count >= 0),
  rows_digest            text        NOT NULL CHECK (rows_digest ~ '^[0-9a-f]{64}$'),
  sealed_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT warehouse_dataset_version_seals_version_unique UNIQUE (dataset_version_id),
  CONSTRAINT warehouse_dataset_version_seals_scope_key UNIQUE (dataset_version_id, dataset_id, tenant_id, workspace_id, business_id),
  CONSTRAINT warehouse_dataset_version_seals_count_check CHECK (row_count = declared_record_count),
  CONSTRAINT warehouse_dataset_version_seals_version_fk FOREIGN KEY (dataset_version_id, dataset_id, tenant_id, workspace_id, business_id)
    REFERENCES business_intelligence.analytical_dataset_versions (id, dataset_id, tenant_id, workspace_id, business_id) ON DELETE RESTRICT
);
COMMENT ON TABLE business_intelligence.warehouse_dataset_version_seals IS
  'Append-only. Locks the rows of a dataset version. row_count, declared_record_count and rows_digest are computed by the database from the stored rows and the record count Business Operations declared; the caller supplies only the version.';

CREATE FUNCTION business_intelligence.check_warehouse_row_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v  record;
  sr record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('bi_warehouse_version:' || NEW.dataset_version_id::text, 0));
  SELECT publication_status, intake_package_id INTO v FROM business_intelligence.analytical_dataset_versions
    WHERE id = NEW.dataset_version_id AND dataset_id = NEW.dataset_id AND tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id AND business_id = NEW.business_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'warehouse row must belong to a dataset version of its own tenant, workspace, business and dataset' USING ERRCODE = '23503';
  END IF;
  IF v.publication_status <> 'published' THEN
    RAISE EXCEPTION 'warehouse rows can be recorded only for a published dataset version' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM business_intelligence.warehouse_dataset_version_seals s WHERE s.dataset_version_id = NEW.dataset_version_id) THEN
    RAISE EXCEPTION 'the dataset version is sealed: no row can be added' USING ERRCODE = '23514';
  END IF;
  SELECT intake_package_id INTO sr FROM business_intelligence.intelligence_source_references
    WHERE id = NEW.source_reference_id AND tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id AND business_id = NEW.business_id;
  IF NOT FOUND OR v.intake_package_id IS NULL OR sr.intake_package_id IS DISTINCT FROM v.intake_package_id THEN
    RAISE EXCEPTION 'a warehouse row must cite a source reference of the intake package its dataset version was built from' USING ERRCODE = '23514';
  END IF;
  NEW.row_fingerprint := encode(sha256(convert_to(NEW.row_data::text, 'UTF8')), 'hex');
  NEW.recorded_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER check_warehouse_row_before_insert BEFORE INSERT ON business_intelligence.warehouse_dataset_rows
  FOR EACH ROW EXECUTE FUNCTION business_intelligence.check_warehouse_row_before_insert();

CREATE FUNCTION business_intelligence.compute_warehouse_version_seal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v        record;
  declared integer;
  c        integer;
  mn       integer;
  mx       integer;
  digest   text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('bi_warehouse_version:' || NEW.dataset_version_id::text, 0));
  SELECT publication_status INTO v FROM business_intelligence.analytical_dataset_versions
    WHERE id = NEW.dataset_version_id AND dataset_id = NEW.dataset_id AND tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id AND business_id = NEW.business_id;
  IF NOT FOUND OR v.publication_status <> 'published' THEN
    RAISE EXCEPTION 'only a published dataset version of its own scope can be sealed' USING ERRCODE = '23514';
  END IF;
  SELECT r.record_count INTO declared FROM business_intelligence.dataset_data_references r
    WHERE r.dataset_version_id = NEW.dataset_version_id AND r.tenant_id = NEW.tenant_id AND r.workspace_id = NEW.workspace_id AND r.business_id = NEW.business_id
    ORDER BY r.created_at, r.id LIMIT 1;
  IF declared IS NULL THEN
    RAISE EXCEPTION 'the dataset version has no declared record count to seal against' USING ERRCODE = '23514';
  END IF;
  SELECT count(*), min(row_number), max(row_number),
         encode(sha256(convert_to(coalesce(string_agg(row_fingerprint, ',' ORDER BY row_number), ''), 'UTF8')), 'hex')
    INTO c, mn, mx, digest
    FROM business_intelligence.warehouse_dataset_rows
   WHERE dataset_version_id = NEW.dataset_version_id AND tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id AND business_id = NEW.business_id;
  IF c <> declared THEN
    RAISE EXCEPTION 'the dataset version holds % rows but % were declared', c, declared USING ERRCODE = '23514';
  END IF;
  IF c > 0 AND (mn <> 1 OR mx <> c) THEN
    RAISE EXCEPTION 'warehouse row numbers must run from 1 to the row count without gaps' USING ERRCODE = '23514';
  END IF;
  NEW.row_count := c; NEW.declared_record_count := declared; NEW.rows_digest := digest; NEW.sealed_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER compute_warehouse_version_seal BEFORE INSERT ON business_intelligence.warehouse_dataset_version_seals
  FOR EACH ROW EXECUTE FUNCTION business_intelligence.compute_warehouse_version_seal();

-- ── calculation runs, the sealed versions they read, and their results ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE business_intelligence.metric_calculation_runs (
  id                        uuid        PRIMARY KEY,
  tenant_id                 uuid        NOT NULL REFERENCES tenancy.tenants(id)     ON DELETE RESTRICT,
  workspace_id              uuid        NOT NULL REFERENCES tenancy.workspaces(id)  ON DELETE RESTRICT,
  business_id               uuid        NOT NULL REFERENCES platform.businesses(id) ON DELETE RESTRICT,
  calculation_handoff_id    uuid        NOT NULL,
  warehouse_snapshot_id     text        CHECK (warehouse_snapshot_id IS NULL OR char_length(btrim(warehouse_snapshot_id)) > 0),
  correlation_id            text        NOT NULL CHECK (char_length(correlation_id) > 0),
  handoff_source_timestamp  timestamptz NOT NULL,
  metric_count              integer     NOT NULL CHECK (metric_count >= 1),
  result_count              integer     NOT NULL CHECK (result_count >= 1),
  input_count               integer     NOT NULL CHECK (input_count >= 0),
  datasets                  jsonb       NOT NULL CHECK (jsonb_typeof(datasets) = 'array' AND jsonb_array_length(datasets) = input_count),
  run_digest                text        NOT NULL CHECK (run_digest ~ '^[0-9a-f]{64}$'),
  status                    text        NOT NULL DEFAULT 'completed' CHECK (status = 'completed'),
  persisted_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT metric_calculation_runs_scope_key UNIQUE (id, tenant_id, workspace_id, business_id)
);
CREATE INDEX metric_calculation_runs_business_idx ON business_intelligence.metric_calculation_runs (business_id, persisted_at DESC);
CREATE INDEX metric_calculation_runs_handoff_idx  ON business_intelligence.metric_calculation_runs (business_id, calculation_handoff_id);
COMMENT ON TABLE business_intelligence.metric_calculation_runs IS
  'Append-only. One governed BI-10 calculation run. handoff_source_timestamp is the stored time of the BI-09 hand-off source; persisted_at is the database clock and cannot be supplied.';

CREATE TABLE business_intelligence.metric_calculation_run_inputs (
  id                  uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid    NOT NULL REFERENCES tenancy.tenants(id)     ON DELETE RESTRICT,
  workspace_id        uuid    NOT NULL REFERENCES tenancy.workspaces(id)  ON DELETE RESTRICT,
  business_id         uuid    NOT NULL REFERENCES platform.businesses(id) ON DELETE RESTRICT,
  run_id              uuid    NOT NULL,
  dataset_id          uuid    NOT NULL,
  dataset_version_id  uuid    NOT NULL,
  row_count           integer NOT NULL CHECK (row_count >= 0),
  rows_fingerprint    text    NOT NULL CHECK (rows_fingerprint ~ '^[0-9a-f]{64}$'),
  seal_digest         text    NOT NULL CHECK (seal_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT metric_calculation_run_inputs_unique UNIQUE (run_id, dataset_id),
  CONSTRAINT metric_calculation_run_inputs_run_fk FOREIGN KEY (run_id, tenant_id, workspace_id, business_id)
    REFERENCES business_intelligence.metric_calculation_runs (id, tenant_id, workspace_id, business_id) ON DELETE RESTRICT,
  CONSTRAINT metric_calculation_run_inputs_seal_fk FOREIGN KEY (dataset_version_id, dataset_id, tenant_id, workspace_id, business_id)
    REFERENCES business_intelligence.warehouse_dataset_version_seals (dataset_version_id, dataset_id, tenant_id, workspace_id, business_id) ON DELETE RESTRICT
);
COMMENT ON TABLE business_intelligence.metric_calculation_run_inputs IS
  'Append-only. The sealed dataset version (and its row digest) a calculation run read: the link from a result back to governed warehouse evidence.';

CREATE TABLE business_intelligence.metric_results (
  id                    uuid        PRIMARY KEY,
  tenant_id             uuid        NOT NULL REFERENCES tenancy.tenants(id)     ON DELETE RESTRICT,
  workspace_id          uuid        NOT NULL REFERENCES tenancy.workspaces(id)  ON DELETE RESTRICT,
  business_id           uuid        NOT NULL REFERENCES platform.businesses(id) ON DELETE RESTRICT,
  run_id                uuid        NOT NULL,
  metric_definition_id  uuid        NOT NULL,
  metric_version        integer     NOT NULL CHECK (metric_version >= 1),
  metric_code           text        NOT NULL CHECK (char_length(metric_code) > 0),
  metric_type           text        NOT NULL CHECK (metric_type IN ('base','derived','ratio','rate','target')),
  metric_content_hash   text        NOT NULL CHECK (metric_content_hash ~ '^[0-9a-f]{64}$'),
  warehouse_dataset_id  uuid        NOT NULL,
  group_key             text        NOT NULL CHECK (char_length(group_key) > 0),
  group_dimensions      jsonb       NOT NULL CHECK (jsonb_typeof(group_dimensions) = 'object'),
  time_bucket           text,
  value                 numeric,
  unit                  text        NOT NULL CHECK (char_length(unit) > 0),
  currency              text,
  target                numeric,
  threshold_status      text        NOT NULL CHECK (threshold_status IN ('no_data','normal','warning','critical','good')),
  target_met            boolean,
  source_row_count      integer     CHECK (source_row_count IS NULL OR source_row_count >= 0),
  calculation_status    text        NOT NULL CHECK (calculation_status IN ('completed','no_data')),
  persisted_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT metric_results_status_check CHECK (
    (value IS NULL) = (calculation_status = 'no_data') AND (value IS NULL) = (threshold_status = 'no_data')),
  CONSTRAINT metric_results_natural_key UNIQUE (run_id, metric_definition_id, metric_version, group_key),
  CONSTRAINT metric_results_run_fk FOREIGN KEY (run_id, tenant_id, workspace_id, business_id)
    REFERENCES business_intelligence.metric_calculation_runs (id, tenant_id, workspace_id, business_id) ON DELETE RESTRICT,
  CONSTRAINT metric_results_definition_fk FOREIGN KEY (metric_definition_id, metric_version, tenant_id, workspace_id, business_id)
    REFERENCES business_intelligence.metric_definition_versions (metric_definition_id, version_number, tenant_id, workspace_id, business_id) ON DELETE RESTRICT,
  CONSTRAINT metric_results_dataset_fk FOREIGN KEY (warehouse_dataset_id, tenant_id, workspace_id, business_id)
    REFERENCES business_intelligence.analytical_datasets (id, tenant_id, workspace_id, business_id) ON DELETE RESTRICT
);
CREATE INDEX metric_results_run_idx ON business_intelligence.metric_results (run_id);
CREATE INDEX metric_results_metric_idx ON business_intelligence.metric_results (business_id, metric_definition_id, metric_version);
COMMENT ON TABLE business_intelligence.metric_results IS
  'Append-only. One governed BI-10 metric result of a run. value and target are exact decimals (numeric), null when there was nothing to calculate.';

-- A run row, an input row and a result row get the database clock and must agree with what they cite.
CREATE FUNCTION business_intelligence.stamp_persisted_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.persisted_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER stamp_persisted_at BEFORE INSERT ON business_intelligence.metric_calculation_runs
  FOR EACH ROW EXECUTE FUNCTION business_intelligence.stamp_persisted_at();
CREATE TRIGGER stamp_persisted_at BEFORE INSERT ON business_intelligence.metric_results
  FOR EACH ROW EXECUTE FUNCTION business_intelligence.stamp_persisted_at();

CREATE FUNCTION business_intelligence.check_run_input_against_seal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s record;
BEGIN
  SELECT row_count, rows_digest INTO s FROM business_intelligence.warehouse_dataset_version_seals
    WHERE dataset_version_id = NEW.dataset_version_id AND dataset_id = NEW.dataset_id AND tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id AND business_id = NEW.business_id;
  IF NOT FOUND OR s.row_count <> NEW.row_count OR s.rows_digest <> NEW.seal_digest THEN
    RAISE EXCEPTION 'a run input must state the row count and digest of the sealed dataset version it read' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER check_run_input_against_seal BEFORE INSERT ON business_intelligence.metric_calculation_run_inputs
  FOR EACH ROW EXECUTE FUNCTION business_intelligence.check_run_input_against_seal();

CREATE FUNCTION business_intelligence.check_metric_result_against_definition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d record;
BEGIN
  SELECT content_hash, warehouse_dataset_id, definition_content ->> 'code' AS code, definition_content ->> 'metricType' AS metric_type
    INTO d FROM business_intelligence.metric_definition_versions
   WHERE metric_definition_id = NEW.metric_definition_id AND version_number = NEW.metric_version
     AND tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id AND business_id = NEW.business_id;
  IF NOT FOUND OR d.content_hash IS NULL THEN
    RAISE EXCEPTION 'a metric result must cite a governed metric definition version of its own scope' USING ERRCODE = '23514';
  END IF;
  IF d.content_hash <> NEW.metric_content_hash OR d.warehouse_dataset_id <> NEW.warehouse_dataset_id
     OR d.code IS DISTINCT FROM NEW.metric_code OR d.metric_type IS DISTINCT FROM NEW.metric_type THEN
    RAISE EXCEPTION 'a metric result disagrees with the stored definition version it cites' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER check_metric_result_against_definition BEFORE INSERT ON business_intelligence.metric_results
  FOR EACH ROW EXECUTE FUNCTION business_intelligence.check_metric_result_against_definition();

-- A run is complete or absent: checked when the transaction commits, so the run row, its inputs and its results are written in any order but never partially.
CREATE FUNCTION business_intelligence.check_metric_calculation_run_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  results_n integer; inputs_n integer; matched integer; uncovered integer;
BEGIN
  SELECT count(*) INTO results_n FROM business_intelligence.metric_results
   WHERE run_id = NEW.id AND tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id AND business_id = NEW.business_id;
  SELECT count(*) INTO inputs_n FROM business_intelligence.metric_calculation_run_inputs
   WHERE run_id = NEW.id AND tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id AND business_id = NEW.business_id;
  IF results_n <> NEW.result_count OR inputs_n <> NEW.input_count THEN
    RAISE EXCEPTION 'calculation run % is incomplete: % of % results, % of % inputs', NEW.id, results_n, NEW.result_count, inputs_n, NEW.input_count USING ERRCODE = '23514';
  END IF;
  SELECT count(*) INTO matched FROM jsonb_array_elements(NEW.datasets) e
    JOIN business_intelligence.metric_calculation_run_inputs i
      ON i.run_id = NEW.id AND i.dataset_id::text = e ->> 'warehouseDatasetId'
     AND i.row_count::text = e ->> 'rowCount' AND i.rows_fingerprint = e ->> 'rowsFingerprint';
  IF matched <> NEW.input_count THEN
    RAISE EXCEPTION 'calculation run % states dataset fingerprints that its inputs do not carry', NEW.id USING ERRCODE = '23514';
  END IF;
  SELECT count(*) INTO uncovered FROM business_intelligence.metric_results r
   WHERE r.run_id = NEW.id AND r.metric_type = 'base'
     AND NOT EXISTS (SELECT 1 FROM business_intelligence.metric_calculation_run_inputs i WHERE i.run_id = NEW.id AND i.dataset_id = r.warehouse_dataset_id);
  IF uncovered > 0 THEN
    RAISE EXCEPTION 'calculation run % has base results from a dataset it did not read', NEW.id USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER check_metric_calculation_run_complete AFTER INSERT ON business_intelligence.metric_calculation_runs
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION business_intelligence.check_metric_calculation_run_complete();

-- ── append-only and tenant-isolated ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['warehouse_dataset_rows','warehouse_dataset_version_seals','metric_calculation_runs','metric_calculation_run_inputs','metric_results'] LOOP
    EXECUTE format('CREATE TRIGGER forbid_mutation_%1$s BEFORE UPDATE OR DELETE ON business_intelligence.%1$s FOR EACH ROW EXECUTE FUNCTION business_intelligence.forbid_mutation()', t);
    EXECUTE format('CREATE TRIGGER forbid_truncate_%1$s BEFORE TRUNCATE ON business_intelligence.%1$s FOR EACH STATEMENT EXECUTE FUNCTION business_intelligence.forbid_mutation()', t);
    EXECUTE format('ALTER TABLE business_intelligence.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE business_intelligence.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY %1$s_tenant_isolation ON business_intelligence.%1$s
      USING (tenant_id = current_setting('app.tenant_id', true)::uuid AND workspace_id = current_setting('app.workspace_id', true)::uuid)$p$, t);
  END LOOP;
END $$;

INSERT INTO _migrations (filename) VALUES ('0223_bi10_warehouse_rows_and_calculation_persistence.sql') ON CONFLICT (filename) DO NOTHING;

COMMIT;
