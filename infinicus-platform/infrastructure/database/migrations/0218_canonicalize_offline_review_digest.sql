-- M1-A6-FIX-1: version future evidence digests; preserve every V1 digest unchanged.
BEGIN;

ALTER TABLE business_operations.offline_review_evidence
  ADD COLUMN digest_version text NOT NULL DEFAULT 'V1_SESSION_TZ'
  CHECK (digest_version IN ('V1_SESSION_TZ', 'V2_UTC'));

CREATE OR REPLACE FUNCTION business_operations.prepare_offline_review_evidence()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_row record;
  last_event record;
BEGIN
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
  NEW.digest_version := 'V2_UTC';
  -- A fixed UTC timestamp and an explicit format version make this digest
  -- reproducible regardless of the writer or reader session TimeZone.
  NEW.event_digest := encode(digest(jsonb_build_array(NEW.digest_version, NEW.event_id,
    NEW.tenant_id, NEW.workspace_id, NEW.business_id, NEW.offline_sale_id,
    NEW.client_sale_id, NEW.intake_request_digest, NEW.resolution_id, NEW.event_version,
    NEW.previous_event_id, NEW.previous_event_digest, NEW.supersedes_event_id,
    NEW.event_type, NEW.reason_code, NEW.source_reference, NEW.actor_id,
    NEW.service_reference, NEW.idempotency_key, NEW.request_digest,
    to_char(NEW.recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))::text,
    'sha256'), 'hex');
  RETURN NEW;
END;
$$;

COMMENT ON COLUMN business_operations.offline_review_evidence.actor_id IS
  'Unverified provenance claim. Does not establish authentication, consent or approval.';
COMMENT ON COLUMN business_operations.offline_review_evidence.service_reference IS
  'Unverified provenance claim. A future approved writer must bind service identity independently.';

INSERT INTO _migrations (filename) VALUES ('0218_canonicalize_offline_review_digest.sql')
  ON CONFLICT (filename) DO NOTHING;
COMMIT;
