-- BO-PUB-DEV-02: durable, BO-owned, immutable publication evidence for the inventory movement ledger (development candidate contract of BO-PUB-DEV-01).
-- Forward-only and additive: two new tables and one scope key on an existing table; no existing row, column, trigger or policy is changed and nothing is dropped.
--
--  * bo_publication_evidence: ONE immutable evidence artifact per BO publication header (UNIQUE publication_package_id). It stores the exact canonical body that was
--    hashed (canonical_body) and the metadata of the artifact. The database enforces what it can verify itself:
--      - the digest is the SHA-256 of 'bo-evidence-body:' || canonical_body, and the evidence id is derived from the digest (both CHECK constraints);
--      - every identity column agrees with the body the digest covers (tenant, workspace, business, header id, domain, period, schema version, record count);
--      - the header is the authoritative BO header of the SAME tenant, workspace and business (composite foreign key), is addressed to Business Intelligence, is in a
--        published state (ready, dispatched, received), covers exactly this period and declares exactly this record count (before-insert trigger; the declared count
--        is read from the header, never supplied by the caller);
--      - created_at is the database clock.
--  * bo_publication_evidence_records: the ordered records. Each record carries the evidence's tenant, workspace and business (composite foreign key), a position
--    1..record_count and the movement id. A deferred check at commit makes the evidence COMPLETE OR ABSENT: the number of records equals the declared count, positions
--    run 1..n without gaps, and the records equal the canonical body's records exactly. After commit nothing can be added (count reached) or changed.
--  * Both tables are append-only (update, delete and truncate refused, reusing business_operations.forbid_mutation) with forced row-level security (tenant+workspace).
--
-- Nothing here publishes anything, changes a header's state, adds a permission or an event, or touches an operational table. Quantities and costs are canonical
-- decimal TEXT inside the body and the records (jsonb strings); there is no numeric or floating-point column for them.
-- Rollback (development only, never after rows exist in a shared environment): DROP TABLE business_operations.bo_publication_evidence_records,
-- business_operations.bo_publication_evidence; DROP the two functions below; then drop bo_publication_packages_scope_key.
BEGIN;

ALTER TABLE business_operations.bo_publication_packages
  ADD CONSTRAINT bo_publication_packages_scope_key UNIQUE (id, tenant_id, workspace_id, business_id);

CREATE TABLE business_operations.bo_publication_evidence (
  id                      uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid         NOT NULL REFERENCES tenancy.tenants(id)     ON DELETE RESTRICT,
  workspace_id            uuid         NOT NULL REFERENCES tenancy.workspaces(id)  ON DELETE RESTRICT,
  business_id             uuid         NOT NULL REFERENCES platform.businesses(id) ON DELETE RESTRICT,
  publication_package_id  uuid         NOT NULL,
  contract_name           text         NOT NULL CHECK (contract_name = 'bo.inventory_movements.record_evidence'),
  contract_version        text         NOT NULL CHECK (contract_version = '0.1.0-proposed'),
  contract_status         text         NOT NULL CHECK (contract_status = 'PROPOSED_NOT_ACTIVE'),
  record_schema_version   text         NOT NULL CHECK (record_schema_version = 'bo.inventory_movement.record.v0.1-proposed'),
  domain                  text         NOT NULL CHECK (domain = 'inventory_movements'),
  period_start            timestamptz  NOT NULL,
  period_end              timestamptz  NOT NULL,
  ordering                text         NOT NULL CHECK (ordering = 'occurredAt asc, movementId asc'),
  canonicalization        text         NOT NULL CHECK (canonicalization = 'bo-canonical-json-v1'),
  digest_algorithm        text         NOT NULL CHECK (digest_algorithm = 'sha256'),
  declared_record_count   integer      NOT NULL,
  record_count            integer      NOT NULL CHECK (record_count BETWEEN 0 AND 100000),
  digest                  char(64)     NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  evidence_id             char(64)     NOT NULL CHECK (evidence_id ~ '^[0-9a-f]{64}$'),
  canonical_body          text         NOT NULL,
  correlation_id          uuid         NOT NULL,
  created_at              timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT bo_publication_evidence_header_fk FOREIGN KEY (publication_package_id, tenant_id, workspace_id, business_id)
    REFERENCES business_operations.bo_publication_packages (id, tenant_id, workspace_id, business_id) ON DELETE RESTRICT,
  CONSTRAINT bo_publication_evidence_one_per_header UNIQUE (publication_package_id),
  CONSTRAINT bo_publication_evidence_evidence_id_key UNIQUE (evidence_id),
  CONSTRAINT bo_publication_evidence_scope_key UNIQUE (id, tenant_id, workspace_id, business_id),
  CONSTRAINT bo_publication_evidence_period_check CHECK (period_end > period_start),
  CONSTRAINT bo_publication_evidence_counts_agree CHECK (declared_record_count = record_count),
  CONSTRAINT bo_publication_evidence_digest_matches CHECK (digest = encode(sha256(convert_to('bo-evidence-body:' || canonical_body, 'UTF8')), 'hex')),
  CONSTRAINT bo_publication_evidence_id_matches CHECK (evidence_id = encode(sha256(convert_to('bo-evidence-id:' || contract_name || ':' || digest, 'UTF8')), 'hex'))
);

CREATE TABLE business_operations.bo_publication_evidence_records (
  tenant_id         uuid     NOT NULL REFERENCES tenancy.tenants(id)     ON DELETE RESTRICT,
  workspace_id      uuid     NOT NULL REFERENCES tenancy.workspaces(id)  ON DELETE RESTRICT,
  business_id       uuid     NOT NULL REFERENCES platform.businesses(id) ON DELETE RESTRICT,
  evidence_row_id   uuid     NOT NULL,
  position          integer  NOT NULL CHECK (position >= 1 AND position <= 100000),
  movement_id       uuid     NOT NULL,
  record            jsonb    NOT NULL,
  PRIMARY KEY (evidence_row_id, position),
  CONSTRAINT bo_publication_evidence_records_movement_unique UNIQUE (evidence_row_id, movement_id),
  CONSTRAINT bo_publication_evidence_records_evidence_fk FOREIGN KEY (evidence_row_id, tenant_id, workspace_id, business_id)
    REFERENCES business_operations.bo_publication_evidence (id, tenant_id, workspace_id, business_id) ON DELETE RESTRICT
);

-- ── before an evidence row is stored: bind it to the authoritative header and to the body the digest covers ────────────────────────────────────────

CREATE OR REPLACE FUNCTION business_operations.check_bo_publication_evidence() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE h record; b jsonb;
BEGIN
  SELECT target_layer, package_status, record_count, period_start, period_end INTO h FROM business_operations.bo_publication_packages
   WHERE id = NEW.publication_package_id AND tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id AND business_id = NEW.business_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'evidence: the publication header is not in this scope' USING ERRCODE = 'foreign_key_violation'; END IF;
  IF h.target_layer <> 'business_intelligence' THEN RAISE EXCEPTION 'evidence: the publication header is not addressed to business intelligence' USING ERRCODE = 'check_violation'; END IF;
  IF h.package_status NOT IN ('ready', 'dispatched', 'received') THEN RAISE EXCEPTION 'evidence: the publication header is not in a published state' USING ERRCODE = 'check_violation'; END IF;
  IF h.period_start <> NEW.period_start OR h.period_end <> NEW.period_end THEN RAISE EXCEPTION 'evidence: the period differs from the publication header' USING ERRCODE = 'check_violation'; END IF;
  IF h.record_count <> NEW.record_count THEN RAISE EXCEPTION 'evidence: the record count differs from the publication header' USING ERRCODE = 'check_violation'; END IF;
  -- the declared count is the header's, never the caller's
  NEW.declared_record_count := h.record_count;
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

-- ── before a record is stored: it must belong to its evidence ───────────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION business_operations.check_bo_publication_evidence_record() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  SELECT record_count INTO n FROM business_operations.bo_publication_evidence
   WHERE id = NEW.evidence_row_id AND tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id AND business_id = NEW.business_id;
  IF NOT FOUND OR NEW.position > n THEN RAISE EXCEPTION 'evidence record: position is outside the evidence' USING ERRCODE = 'check_violation'; END IF;
  IF jsonb_typeof(NEW.record) <> 'object' OR (NEW.record->>'movementId') IS DISTINCT FROM NEW.movement_id::text
     OR (NEW.record->>'tenantId') IS DISTINCT FROM NEW.tenant_id::text OR (NEW.record->>'workspaceId') IS DISTINCT FROM NEW.workspace_id::text OR (NEW.record->>'businessId') IS DISTINCT FROM NEW.business_id::text THEN
    RAISE EXCEPTION 'evidence record: identity or scope disagrees with the record' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER check_bo_publication_evidence_record BEFORE INSERT ON business_operations.bo_publication_evidence_records
  FOR EACH ROW EXECUTE FUNCTION business_operations.check_bo_publication_evidence_record();

-- ── complete or absent: checked once, at commit ─────────────────────────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION business_operations.check_bo_publication_evidence_complete() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE n integer; mx integer; agg jsonb;
BEGIN
  SELECT count(*), coalesce(max(position), 0), coalesce(jsonb_agg(record ORDER BY position), '[]'::jsonb) INTO n, mx, agg
    FROM business_operations.bo_publication_evidence_records WHERE evidence_row_id = NEW.id AND tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id AND business_id = NEW.business_id;
  IF n <> NEW.record_count OR mx <> NEW.record_count THEN
    RAISE EXCEPTION 'evidence: % records stored for % declared, positions must run 1..n', n, NEW.record_count USING ERRCODE = 'check_violation';
  END IF;
  IF agg IS DISTINCT FROM (NEW.canonical_body::jsonb -> 'records') THEN
    RAISE EXCEPTION 'evidence: the stored records differ from the canonical body' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER check_bo_publication_evidence_complete AFTER INSERT ON business_operations.bo_publication_evidence
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION business_operations.check_bo_publication_evidence_complete();

-- ── append-only and tenant-isolated ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['bo_publication_evidence', 'bo_publication_evidence_records'] LOOP
    EXECUTE format('CREATE TRIGGER forbid_mutation_%1$s BEFORE UPDATE OR DELETE ON business_operations.%1$s FOR EACH ROW EXECUTE FUNCTION business_operations.forbid_mutation()', t);
    EXECUTE format('CREATE TRIGGER forbid_truncate_%1$s BEFORE TRUNCATE ON business_operations.%1$s FOR EACH STATEMENT EXECUTE FUNCTION business_operations.forbid_mutation()', t);
    EXECUTE format('ALTER TABLE business_operations.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE business_operations.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY %1$s_tenant_isolation ON business_operations.%1$s
      USING (tenant_id = current_setting('app.tenant_id', true)::uuid AND workspace_id = current_setting('app.workspace_id', true)::uuid)$p$, t);
  END LOOP;
END $$;

INSERT INTO _migrations (filename) VALUES ('0224_bo_publication_evidence.sql') ON CONFLICT (filename) DO NOTHING;

COMMIT;
