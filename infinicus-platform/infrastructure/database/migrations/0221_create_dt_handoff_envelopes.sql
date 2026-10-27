-- NEW-BDT-SIM-01.SEC-01 (D2): the durable record of every Digital Twin -> Simulation hand-off envelope (layer-handoff-contracts section 30: "No handoff should exist
-- only in memory"). Forward-only and additive; no existing table or migration is changed.
--
--  * One row per publication package: the COMPLETE frozen DT -> SIM envelope (contract and schema versions, scope, snapshot identity, evidence references,
--    variables with their units, quality/confidence, assumptions, lineage), its SHA-256 digest, the confidence score it rests on (twin_confidence_scores, which
--    holds the calculation basis) and the BI source digest that was re-verified immediately before the commit.
--  * Append-only (no update, delete or truncate) and tenant/workspace isolated by forced row-level security.
--  * Persist-before-publication is enforced IN THE DATABASE: an envelope can only be recorded while its package is still a draft, and a hand-off package of this
--    kind (idempotency key 'bdt-performance-sim:%') cannot become ready or dispatched without one.
--  * Cross-tenant, cross-workspace and cross-business references are refused: the package, snapshot version and confidence score must belong to the envelope's
--    own tenant, workspace and business, and the envelope's own scope fields must agree with the row.
-- Rollback (development only, never after rows exist in a shared environment): DROP TRIGGER require_handoff_envelope_before_ready ON
-- business_digital_twin.dt_publication_packages; DROP TABLE business_digital_twin.dt_handoff_envelopes; DROP FUNCTION business_digital_twin.require_handoff_envelope_before_ready();
-- DROP FUNCTION business_digital_twin.check_handoff_envelope_scope();
BEGIN;

CREATE TABLE business_digital_twin.dt_handoff_envelopes (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 uuid        NOT NULL REFERENCES tenancy.tenants(id)      ON DELETE RESTRICT,
  workspace_id              uuid        NOT NULL REFERENCES tenancy.workspaces(id)   ON DELETE RESTRICT,
  business_id               uuid        NOT NULL REFERENCES platform.businesses(id)  ON DELETE RESTRICT,
  dt_publication_package_id uuid        NOT NULL REFERENCES business_digital_twin.dt_publication_packages(id)       ON DELETE RESTRICT,
  snapshot_version_id       uuid        NOT NULL REFERENCES business_digital_twin.digital_twin_snapshot_versions(id) ON DELETE RESTRICT,
  confidence_score_id       uuid        NOT NULL REFERENCES business_digital_twin.twin_confidence_scores(id)         ON DELETE RESTRICT,
  contract_version          text        NOT NULL CHECK (char_length(contract_version) BETWEEN 1 AND 32),
  schema_version            text        NOT NULL CHECK (char_length(schema_version) BETWEEN 1 AND 64),
  correlation_id            uuid        NOT NULL,
  causation_id              uuid        NOT NULL,
  envelope                  jsonb       NOT NULL CHECK (jsonb_typeof(envelope) = 'object'),
  envelope_digest           text        NOT NULL CHECK (envelope_digest ~ '^[0-9a-f]{64}$'),
  source_evidence_digest    text        NOT NULL CHECK (source_evidence_digest ~ '^[0-9a-f]{64}$'),
  source_revalidated_at     timestamptz NOT NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dt_handoff_envelopes_package_unique UNIQUE (dt_publication_package_id)
);
CREATE INDEX dt_handoff_envelopes_business_idx ON business_digital_twin.dt_handoff_envelopes (business_id, created_at DESC);
COMMENT ON TABLE business_digital_twin.dt_handoff_envelopes IS
  'Append-only. The complete DT -> SIM hand-off envelope, persisted before its package may become ready or dispatched.';

CREATE FUNCTION business_digital_twin.check_handoff_envelope_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  pkg record; sv record; cs record;
BEGIN
  SELECT tenant_id, workspace_id, business_id, idempotency_key, publication_status INTO pkg
    FROM business_digital_twin.dt_publication_packages WHERE id = NEW.dt_publication_package_id;
  IF NOT FOUND OR pkg.tenant_id <> NEW.tenant_id OR pkg.workspace_id <> NEW.workspace_id OR pkg.business_id <> NEW.business_id THEN
    RAISE EXCEPTION 'hand-off envelope must reference a publication package of its own tenant, workspace and business' USING ERRCODE = '23514';
  END IF;
  IF pkg.publication_status <> 'draft' THEN
    RAISE EXCEPTION 'hand-off envelope must be recorded while its package is still a draft (persist before publication)' USING ERRCODE = '23514';
  END IF;
  SELECT tenant_id, workspace_id, business_id INTO sv FROM business_digital_twin.digital_twin_snapshot_versions WHERE id = NEW.snapshot_version_id;
  IF NOT FOUND OR sv.tenant_id <> NEW.tenant_id OR sv.workspace_id <> NEW.workspace_id OR sv.business_id <> NEW.business_id THEN
    RAISE EXCEPTION 'hand-off envelope must reference a snapshot version of its own tenant, workspace and business' USING ERRCODE = '23514';
  END IF;
  SELECT tenant_id, workspace_id, business_id, snapshot_version_id INTO cs FROM business_digital_twin.twin_confidence_scores WHERE id = NEW.confidence_score_id;
  IF NOT FOUND OR cs.tenant_id <> NEW.tenant_id OR cs.workspace_id <> NEW.workspace_id OR cs.business_id <> NEW.business_id
     OR cs.snapshot_version_id IS DISTINCT FROM NEW.snapshot_version_id THEN
    RAISE EXCEPTION 'hand-off envelope must rest on a confidence score of its own scope and snapshot version' USING ERRCODE = '23514';
  END IF;
  IF NEW.envelope #>> '{payload,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
     OR NEW.envelope #>> '{payload,workspaceId}' IS DISTINCT FROM NEW.workspace_id::text
     OR NEW.envelope #>> '{payload,businessId}' IS DISTINCT FROM NEW.business_id::text
     OR NEW.envelope ->> 'handoffId' IS DISTINCT FROM NEW.dt_publication_package_id::text
     OR NEW.envelope #>> '{payload,idempotencyKey}' IS DISTINCT FROM pkg.idempotency_key
     OR NEW.envelope #>> '{payload,contractVersion}' IS DISTINCT FROM NEW.contract_version
     OR NEW.envelope ->> 'sourceLayer' IS DISTINCT FROM 'DT' OR NEW.envelope ->> 'targetLayer' IS DISTINCT FROM 'SIM' THEN
    RAISE EXCEPTION 'hand-off envelope content disagrees with its recorded scope, package or contract version' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER check_handoff_envelope_scope_trg BEFORE INSERT ON business_digital_twin.dt_handoff_envelopes
  FOR EACH ROW EXECUTE FUNCTION business_digital_twin.check_handoff_envelope_scope();

CREATE TRIGGER forbid_mutation_dt_handoff_envelopes BEFORE UPDATE OR DELETE ON business_digital_twin.dt_handoff_envelopes
  FOR EACH ROW EXECUTE FUNCTION business_digital_twin.forbid_mutation();
CREATE TRIGGER forbid_truncate_dt_handoff_envelopes BEFORE TRUNCATE ON business_digital_twin.dt_handoff_envelopes
  FOR EACH STATEMENT EXECUTE FUNCTION business_digital_twin.forbid_mutation();

ALTER TABLE business_digital_twin.dt_handoff_envelopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_digital_twin.dt_handoff_envelopes FORCE ROW LEVEL SECURITY;
CREATE POLICY dt_handoff_envelopes_tenant_isolation ON business_digital_twin.dt_handoff_envelopes
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid AND workspace_id = current_setting('app.workspace_id', true)::uuid);

-- A performance hand-off package may not become ready or dispatched without its persisted envelope. Scoped to packages created by the performance hand-off
-- (idempotency key prefix) because other DT -> SIM packages predate the envelope table and are not affected.
CREATE FUNCTION business_digital_twin.require_handoff_envelope_before_ready() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.idempotency_key LIKE 'bdt-performance-sim:%' AND NEW.publication_status IN ('ready', 'dispatched')
     AND NEW.publication_status IS DISTINCT FROM OLD.publication_status
     AND NOT EXISTS (SELECT 1 FROM business_digital_twin.dt_handoff_envelopes e
                      WHERE e.dt_publication_package_id = NEW.id AND e.tenant_id = NEW.tenant_id
                        AND e.workspace_id = NEW.workspace_id AND e.business_id = NEW.business_id) THEN
    RAISE EXCEPTION 'a performance hand-off package cannot become % before its envelope is persisted', NEW.publication_status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER require_handoff_envelope_before_ready BEFORE UPDATE OF publication_status ON business_digital_twin.dt_publication_packages
  FOR EACH ROW EXECUTE FUNCTION business_digital_twin.require_handoff_envelope_before_ready();

INSERT INTO _migrations (filename) VALUES ('0221_create_dt_handoff_envelopes.sql') ON CONFLICT (filename) DO NOTHING;
COMMIT;
