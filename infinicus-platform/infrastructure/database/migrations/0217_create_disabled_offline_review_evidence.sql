-- M1-A6: disabled BO evidence notes. No application writer or operational review authority.
BEGIN;

-- Bind every event to the immutable intake identity and its original digest.
ALTER TABLE business_operations.offline_sales
  ADD CONSTRAINT offline_sales_review_source_unique
  UNIQUE (id, tenant_id, workspace_id, business_id, client_sale_id, request_digest);

CREATE TABLE business_operations.offline_review_evidence (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  business_id uuid NOT NULL,
  offline_sale_id uuid NOT NULL,
  client_sale_id uuid NOT NULL,
  intake_request_digest text NOT NULL CHECK (intake_request_digest ~ '^[0-9a-f]{64}$'),
  resolution_id uuid NOT NULL,
  event_version integer NOT NULL CHECK (event_version > 0),
  previous_event_id uuid,
  previous_event_digest text CHECK (previous_event_digest ~ '^[0-9a-f]{64}$'),
  supersedes_event_id uuid,
  event_type text NOT NULL CHECK (event_type IN ('EVIDENCE_NOTE_RECORDED','EVIDENCE_NOTE_SUPERSEDED')),
  reason_code text NOT NULL CHECK (reason_code IN ('STRUCTURAL_NOTE','CORRECTION')),
  source_reference uuid NOT NULL,
  actor_id uuid,
  service_reference text CHECK (service_reference ~ '^[A-Za-z0-9._:-]{1,128}$'),
  idempotency_key uuid NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  event_digest text NOT NULL CHECK (event_digest ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz NOT NULL,
  CONSTRAINT review_evidence_provenance CHECK ((actor_id IS NOT NULL) <> (service_reference IS NOT NULL)),
  CONSTRAINT review_evidence_supersession CHECK ((event_type = 'EVIDENCE_NOTE_SUPERSEDED') = (supersedes_event_id IS NOT NULL)),
  CONSTRAINT review_evidence_previous_pair CHECK ((previous_event_id IS NULL) = (previous_event_digest IS NULL)),
  CONSTRAINT review_evidence_source_fk FOREIGN KEY
    (offline_sale_id, tenant_id, workspace_id, business_id, client_sale_id, intake_request_digest)
    REFERENCES business_operations.offline_sales
    (id, tenant_id, workspace_id, business_id, client_sale_id, request_digest) ON DELETE RESTRICT,
  CONSTRAINT review_evidence_actor_fk FOREIGN KEY (actor_id) REFERENCES identity.users(id) ON DELETE RESTRICT,
  CONSTRAINT review_evidence_version_unique UNIQUE (tenant_id, workspace_id, business_id, resolution_id, event_version),
  CONSTRAINT review_evidence_replay_unique UNIQUE (tenant_id, workspace_id, business_id, idempotency_key),
  CONSTRAINT review_evidence_link_unique UNIQUE (tenant_id, workspace_id, business_id, resolution_id, event_id, event_digest),
  CONSTRAINT review_evidence_event_scope_unique UNIQUE (tenant_id, workspace_id, business_id, resolution_id, event_id),
  CONSTRAINT review_evidence_previous_fk FOREIGN KEY
    (tenant_id, workspace_id, business_id, resolution_id, previous_event_id, previous_event_digest)
    REFERENCES business_operations.offline_review_evidence
    (tenant_id, workspace_id, business_id, resolution_id, event_id, event_digest) ON DELETE RESTRICT,
  CONSTRAINT review_evidence_supersedes_fk FOREIGN KEY
    (tenant_id, workspace_id, business_id, resolution_id, supersedes_event_id)
    REFERENCES business_operations.offline_review_evidence
    (tenant_id, workspace_id, business_id, resolution_id, event_id) ON DELETE RESTRICT
);

CREATE INDEX offline_review_evidence_intake_order
  ON business_operations.offline_review_evidence (business_id, offline_sale_id, resolution_id, event_version);

CREATE FUNCTION business_operations.prepare_offline_review_evidence()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_row record;
  last_event record;
BEGIN
  -- A per-resolution lock serializes competing next-version inserts, including an empty chain.
  PERFORM pg_advisory_xact_lock(hashtextextended('offline-review:' || NEW.business_id || ':' || NEW.resolution_id, 0));
  SELECT outcome INTO source_row FROM business_operations.offline_sales
   WHERE id = NEW.offline_sale_id AND tenant_id = NEW.tenant_id
     AND workspace_id = NEW.workspace_id AND business_id = NEW.business_id
     AND client_sale_id = NEW.client_sale_id AND request_digest = NEW.intake_request_digest;
  IF NOT FOUND OR source_row.outcome <> 'needs_review' THEN
    RAISE EXCEPTION 'review evidence requires a scoped needs_review intake' USING ERRCODE = '23514';
  END IF;
  SELECT event_id, event_digest, event_version, offline_sale_id INTO last_event
    FROM business_operations.offline_review_evidence
   WHERE tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id
     AND business_id = NEW.business_id AND resolution_id = NEW.resolution_id
   ORDER BY event_version DESC LIMIT 1;
  IF NOT FOUND THEN
    IF NEW.event_version <> 1 OR NEW.previous_event_id IS NOT NULL THEN
      RAISE EXCEPTION 'first review event must be version 1 without a predecessor' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.event_version <> last_event.event_version + 1
     OR NEW.previous_event_id IS DISTINCT FROM last_event.event_id
     OR NEW.previous_event_digest IS DISTINCT FROM last_event.event_digest
     OR NEW.offline_sale_id IS DISTINCT FROM last_event.offline_sale_id THEN
    RAISE EXCEPTION 'review evidence chain is stale or crosses an intake' USING ERRCODE = '23514';
  END IF;
  NEW.recorded_at := clock_timestamp();
  NEW.event_digest := encode(digest(jsonb_build_array(NEW.event_id, NEW.tenant_id, NEW.workspace_id,
    NEW.business_id, NEW.offline_sale_id, NEW.client_sale_id, NEW.intake_request_digest,
    NEW.resolution_id, NEW.event_version, NEW.previous_event_id, NEW.previous_event_digest,
    NEW.supersedes_event_id, NEW.event_type, NEW.reason_code, NEW.source_reference,
    NEW.actor_id, NEW.service_reference, NEW.idempotency_key, NEW.request_digest,
    NEW.recorded_at)::text, 'sha256'), 'hex');
  RETURN NEW;
END;
$$;

CREATE TRIGGER prepare_offline_review_evidence_trg BEFORE INSERT
  ON business_operations.offline_review_evidence FOR EACH ROW
  EXECUTE FUNCTION business_operations.prepare_offline_review_evidence();
CREATE TRIGGER forbid_mutation_offline_review_evidence BEFORE UPDATE OR DELETE
  ON business_operations.offline_review_evidence FOR EACH ROW
  EXECUTE FUNCTION business_operations.forbid_mutation();
CREATE TRIGGER forbid_truncate_offline_review_evidence BEFORE TRUNCATE
  ON business_operations.offline_review_evidence FOR EACH STATEMENT
  EXECUTE FUNCTION business_operations.forbid_mutation();

ALTER TABLE business_operations.offline_review_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_operations.offline_review_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY offline_review_evidence_scope ON business_operations.offline_review_evidence
  FOR SELECT USING (tenant_id = current_setting('app.tenant_id', true)::uuid
    AND workspace_id = current_setting('app.workspace_id', true)::uuid);
-- There is deliberately no INSERT policy or ordinary application writer.

INSERT INTO _migrations (filename) VALUES ('0217_create_disabled_offline_review_evidence.sql')
  ON CONFLICT (filename) DO NOTHING;
COMMIT;
