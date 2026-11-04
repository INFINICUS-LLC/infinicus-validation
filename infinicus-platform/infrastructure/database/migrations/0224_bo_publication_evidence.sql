-- BO-PUB-DEV-02 (aligned to the R4/D3 association model, docs/production-readiness/BO_PUB_DEV_02A_R4_D3_INACTIVE_PERSISTENCE.md): durable, BO-owned, immutable
-- publication evidence for the inventory movement ledger. Forward-only and additive: ONE new table and ONE parent key on an existing table. No existing row, column,
-- trigger or policy is changed, and nothing is dropped. The contract is still the development candidate (0.1.0-proposed, PROPOSED_NOT_ACTIVE); nothing activates it.
--
--  * bo_publication_evidence is the single immutable ASSOCIATION ROW of D3: one verified artifact per BO publication header, holding the exact canonical body bytes.
--      - ONE SLOT PER HEADER: a non-deferrable UNIQUE on publication_package_id alone (a changed period or version cannot create a second slot).
--      - COMPOSITE PARENT KEY WITH PERIOD PINNING: (publication_package_id, tenant, workspace, business, period_start, period_end) references the same tuple on the header
--        (ON UPDATE RESTRICT, ON DELETE RESTRICT, immediate). The header's scope and period cannot change after association, while unrelated header changes (status,
--        version, timestamps) stay allowed; an association copied from another header or scope fails with 23503 even where the inserting role can see both headers.
--      - IDENTITIES ARE SEPARATE: the row id is a generated UUID; evidence_id is the content-derived identity (CHECK: derived from the digest); the digest is the
--        SHA-256 of 'bo-evidence-body:' || canonical_body (CHECK), so the stored bytes are exactly what was hashed. JSONB is never the equality reference.
--      - Before insert (defence in depth behind the single controlled writer, which also runs the full verifier): the header must be addressed to Business Intelligence,
--        be in the CREATION state 'ready', and declare exactly this record count; scope, header id, domain, schema, contract, ordering and count must agree with the body
--        the digest covers. Replay of an existing association is decided by the writer BEFORE this trigger and is allowed after the header has advanced.
--      - created_at is the database clock; the first correlation id is retained and is not part of content equality.
--  * Append-only (update, delete, truncate refused; reuses business_operations.forbid_mutation) with ENABLE and FORCE row-level security (tenant+workspace policy, as every
--    BO table). Business isolation inside a workspace is the explicit business predicate of every statement and of the composite keys.
--  * No audit, outbox or dispatch event is written and the header is never updated: the header-only dispatch path is untouched. No permission is added.
-- Compatibility note (G2): the parent key adds a unique index on the header and pins (scope, period) of any ASSOCIATED header; headers without evidence are unaffected.
-- Rollback (development only, never after rows exist in a shared environment): DROP TABLE business_operations.bo_publication_evidence; DROP FUNCTION
-- business_operations.check_bo_publication_evidence(); then drop bo_publication_packages_d3_key.
BEGIN;

ALTER TABLE business_operations.bo_publication_packages
  ADD CONSTRAINT bo_publication_packages_d3_key UNIQUE (id, tenant_id, workspace_id, business_id, period_start, period_end);

CREATE TABLE business_operations.bo_publication_evidence (
  id                      uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid         NOT NULL REFERENCES tenancy.tenants(id)     ON DELETE RESTRICT,
  workspace_id            uuid         NOT NULL REFERENCES tenancy.workspaces(id)  ON DELETE RESTRICT,
  business_id             uuid         NOT NULL REFERENCES platform.businesses(id) ON DELETE RESTRICT,
  publication_package_id  uuid         NOT NULL,
  period_start            timestamptz  NOT NULL,
  period_end              timestamptz  NOT NULL,
  contract_name           text         NOT NULL CHECK (contract_name = 'bo.inventory_movements.record_evidence'),
  contract_version        text         NOT NULL CHECK (contract_version = '0.1.0-proposed'),
  contract_status         text         NOT NULL CHECK (contract_status = 'PROPOSED_NOT_ACTIVE'),
  record_schema_version   text         NOT NULL CHECK (record_schema_version = 'bo.inventory_movement.record.v0.1-proposed'),
  domain                  text         NOT NULL CHECK (domain = 'inventory_movements'),
  ordering                text         NOT NULL CHECK (ordering = 'occurredAt asc, movementId asc'),
  canonicalization        text         NOT NULL CHECK (canonicalization = 'bo-canonical-json-v1'),
  digest_algorithm        text         NOT NULL CHECK (digest_algorithm = 'sha256'),
  record_count            integer      NOT NULL CHECK (record_count BETWEEN 0 AND 100000),
  digest                  char(64)     NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  evidence_id             char(64)     NOT NULL CHECK (evidence_id ~ '^[0-9a-f]{64}$'),
  canonical_body          text         NOT NULL,
  correlation_id          uuid         NOT NULL,
  created_at              timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT bo_publication_evidence_header_fk FOREIGN KEY (publication_package_id, tenant_id, workspace_id, business_id, period_start, period_end)
    REFERENCES business_operations.bo_publication_packages (id, tenant_id, workspace_id, business_id, period_start, period_end) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT bo_publication_evidence_one_per_header UNIQUE (publication_package_id),
  CONSTRAINT bo_publication_evidence_evidence_id_key UNIQUE (evidence_id),
  CONSTRAINT bo_publication_evidence_period_check CHECK (period_end > period_start),
  CONSTRAINT bo_publication_evidence_digest_matches CHECK (digest = encode(sha256(convert_to('bo-evidence-body:' || canonical_body, 'UTF8')), 'hex')),
  CONSTRAINT bo_publication_evidence_id_matches CHECK (evidence_id = encode(sha256(convert_to('bo-evidence-id:' || contract_name || ':' || digest, 'UTF8')), 'hex'))
);

-- ── before an evidence row is stored: the creation state of the header and the agreement of the columns with the body the digest covers ───────────

CREATE OR REPLACE FUNCTION business_operations.check_bo_publication_evidence() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE h record; b jsonb;
BEGIN
  SELECT target_layer, package_status, record_count INTO h FROM business_operations.bo_publication_packages
   WHERE id = NEW.publication_package_id AND tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id AND business_id = NEW.business_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'evidence: the publication header is not in this scope' USING ERRCODE = 'foreign_key_violation'; END IF;
  IF h.target_layer <> 'business_intelligence' THEN RAISE EXCEPTION 'evidence: the publication header is not addressed to business intelligence' USING ERRCODE = 'check_violation'; END IF;
  IF h.package_status <> 'ready' THEN RAISE EXCEPTION 'evidence: the publication header is not in the creation state' USING ERRCODE = 'check_violation'; END IF;
  IF h.record_count <> NEW.record_count THEN RAISE EXCEPTION 'evidence: the record count differs from the publication header' USING ERRCODE = 'check_violation'; END IF;
  NEW.created_at := now();

  BEGIN b := NEW.canonical_body::jsonb; EXCEPTION WHEN others THEN RAISE EXCEPTION 'evidence: the canonical body is not JSON' USING ERRCODE = 'check_violation'; END;
  IF jsonb_typeof(b) <> 'object' OR jsonb_typeof(b->'records') <> 'array'
     OR (b->'scope'->>'tenantId') IS DISTINCT FROM NEW.tenant_id::text OR (b->'scope'->>'workspaceId') IS DISTINCT FROM NEW.workspace_id::text OR (b->'scope'->>'businessId') IS DISTINCT FROM NEW.business_id::text
     OR (b->'source'->>'boPublicationPackageId') IS DISTINCT FROM NEW.publication_package_id::text
     OR (b->'source'->>'domain') IS DISTINCT FROM NEW.domain
     OR (b->'source'->>'periodStart') IS DISTINCT FROM to_char(NEW.period_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
     OR (b->'source'->>'periodEnd') IS DISTINCT FROM to_char(NEW.period_end AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
     OR (b->>'recordSchemaVersion') IS DISTINCT FROM NEW.record_schema_version
     OR (b->'contract'->>'name') IS DISTINCT FROM NEW.contract_name OR (b->'contract'->>'version') IS DISTINCT FROM NEW.contract_version OR (b->'contract'->>'status') IS DISTINCT FROM NEW.contract_status
     OR (b->>'ordering') IS DISTINCT FROM NEW.ordering
     OR (b->>'recordCount') IS DISTINCT FROM NEW.record_count::text OR jsonb_array_length(b->'records') <> NEW.record_count THEN
    RAISE EXCEPTION 'evidence: the stored identity does not agree with the canonical body the digest covers' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER check_bo_publication_evidence BEFORE INSERT ON business_operations.bo_publication_evidence
  FOR EACH ROW EXECUTE FUNCTION business_operations.check_bo_publication_evidence();

-- ── append-only and tenant-isolated ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

CREATE TRIGGER forbid_mutation_bo_publication_evidence BEFORE UPDATE OR DELETE ON business_operations.bo_publication_evidence
  FOR EACH ROW EXECUTE FUNCTION business_operations.forbid_mutation();
CREATE TRIGGER forbid_truncate_bo_publication_evidence BEFORE TRUNCATE ON business_operations.bo_publication_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION business_operations.forbid_mutation();
ALTER TABLE business_operations.bo_publication_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_operations.bo_publication_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY bo_publication_evidence_tenant_isolation ON business_operations.bo_publication_evidence
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid AND workspace_id = current_setting('app.workspace_id', true)::uuid);

INSERT INTO _migrations (filename) VALUES ('0224_bo_publication_evidence.sql') ON CONFLICT (filename) DO NOTHING;

COMMIT;
