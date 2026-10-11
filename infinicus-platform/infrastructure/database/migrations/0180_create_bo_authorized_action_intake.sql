-- Migration: 0180_create_bo_authorized_action_intake
-- P0-5 Block 3e (owner-authorised): the Business Operations package intake boundary.
--
-- BO-OWNED persistence only (schema business_operations). It records, for an AuthorizedActionPackage that BO was handed:
--   * an immutable RECEIPT (verbatim sealed document + digest), written only after the ABA-owned authoritative status
--     confirmed the package's identity (id, version, digest) - so an unverified forgery can never occupy an identity;
--   * an immutable single-use CLAIM, exactly one per (package id, package version), the canonical BO truth for consumption.
--     CONSUMED means: BO atomically claimed this package version for one execution attempt. It does NOT mean that anything
--     was executed, succeeded, failed or rolled back (execution evidence is a later, separate fact);
--   * an append-only ATTEMPT log (outcome + refusal codes) so a refusal reason is preserved.
--
-- The ABA package remains the authorization source of truth: the BO copy is receipt evidence only. Package and ABA
-- identifiers are SOFT references - there is no foreign key into approved_business_action and nothing here reads or writes it.
-- No inventory table, event table or ABA table is touched. Nothing is seeded.

BEGIN;

-- ── receipts ───────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS business_operations.authorized_action_receipts (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid        NOT NULL REFERENCES tenancy.tenants(id)     ON DELETE RESTRICT,
  workspace_id       uuid        NOT NULL REFERENCES tenancy.workspaces(id)  ON DELETE RESTRICT,
  business_id        uuid        NOT NULL REFERENCES platform.businesses(id) ON DELETE RESTRICT,
  package_id         uuid        NOT NULL,
  package_version    integer     NOT NULL CHECK (package_version >= 1),
  contract_version   text        NOT NULL CHECK (length(btrim(contract_version)) > 0),
  canonical_version  text        NOT NULL CHECK (length(btrim(canonical_version)) > 0),
  digest_algorithm   text        NOT NULL CHECK (digest_algorithm = 'sha256'),
  digest             text        NOT NULL CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  package            jsonb       NOT NULL,
  received_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  validated_at       timestamptz NOT NULL,
  status_verified_at timestamptz NOT NULL,
  correlation_id     uuid        NOT NULL,

  CONSTRAINT authorized_action_receipts_package_key UNIQUE (package_id, package_version),
  CONSTRAINT authorized_action_receipts_scope_key UNIQUE (id, package_id, package_version, tenant_id, workspace_id, business_id),
  CONSTRAINT authorized_action_receipts_received_ms CHECK (received_at = date_trunc('milliseconds', received_at)),
  CONSTRAINT authorized_action_receipts_validated_ms CHECK (validated_at = date_trunc('milliseconds', validated_at)),
  CONSTRAINT authorized_action_receipts_verified_ms CHECK (status_verified_at = date_trunc('milliseconds', status_verified_at)),
  CONSTRAINT authorized_action_receipts_order CHECK (validated_at <= received_at),
  CONSTRAINT authorized_action_receipts_document_is_object CHECK (jsonb_typeof(package) = 'object'),
  CONSTRAINT authorized_action_receipts_bounded CHECK (octet_length(package::text) <= 262144),
  -- The stored columns must agree with the sealed document, and the document must be a single-use aap package.
  CONSTRAINT authorized_action_receipts_document_identity CHECK (
    (package #>> '{contractVersion}')              IS NOT DISTINCT FROM contract_version
    AND (package #>> '{identity,packageId}')       IS NOT DISTINCT FROM package_id::text
    AND (package #>> '{identity,packageVersion}')  IS NOT DISTINCT FROM package_version::text
    AND (package #>> '{scope,tenantId}')           IS NOT DISTINCT FROM tenant_id::text
    AND (package #>> '{scope,workspaceId}')        IS NOT DISTINCT FROM workspace_id::text
    AND (package #>> '{scope,businessId}')         IS NOT DISTINCT FROM business_id::text
    AND (package #>> '{integrity,canonicalVersion}') IS NOT DISTINCT FROM canonical_version
    AND (package #>> '{integrity,algorithm}')      IS NOT DISTINCT FROM digest_algorithm
    AND (package #>> '{integrity,digest}')         IS NOT DISTINCT FROM digest
    AND (package #>> '{consumption,mode}')         IS NOT DISTINCT FROM 'SINGLE_USE'
  )
);

COMMENT ON TABLE business_operations.authorized_action_receipts IS
  'Append-only. Immutable BO receipt of a sealed AuthorizedActionPackage: verbatim document + digest, written only after ABA''s authoritative status confirmed the package identity. Receipt evidence only - the ABA package remains the authorization source of truth. One row per (package id, package version).';

-- ── claims ─────────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS business_operations.authorized_action_claims (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid        NOT NULL,
  workspace_id       uuid        NOT NULL,
  business_id        uuid        NOT NULL,
  receipt_id         uuid        NOT NULL,
  package_id         uuid        NOT NULL,
  package_version    integer     NOT NULL CHECK (package_version >= 1),
  digest             text        NOT NULL CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  claimed_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  status_verified_at timestamptz NOT NULL,
  correlation_id     uuid        NOT NULL,

  CONSTRAINT authorized_action_claims_receipt_fk
    FOREIGN KEY (receipt_id, package_id, package_version, tenant_id, workspace_id, business_id)
    REFERENCES business_operations.authorized_action_receipts (id, package_id, package_version, tenant_id, workspace_id, business_id)
    ON DELETE RESTRICT,
  -- SINGLE USE: the first claim of a package version wins; the database refuses every other.
  CONSTRAINT authorized_action_claims_single_use UNIQUE (package_id, package_version),
  CONSTRAINT authorized_action_claims_claimed_ms CHECK (claimed_at = date_trunc('milliseconds', claimed_at)),
  CONSTRAINT authorized_action_claims_verified_ms CHECK (status_verified_at = date_trunc('milliseconds', status_verified_at))
);

COMMENT ON TABLE business_operations.authorized_action_claims IS
  'Append-only. Canonical BO truth for consumption: BO atomically claimed this package version for ONE execution attempt (unique per package id + version). Not execution, success, failure or rollback.';

-- ── attempts ───────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS business_operations.authorized_action_intake_attempts (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid        NOT NULL REFERENCES tenancy.tenants(id)     ON DELETE RESTRICT,
  workspace_id     uuid        NOT NULL REFERENCES tenancy.workspaces(id)  ON DELETE RESTRICT,
  business_id      uuid        NOT NULL REFERENCES platform.businesses(id) ON DELETE RESTRICT,
  package_id       uuid,
  package_version  integer     CHECK (package_version IS NULL OR package_version >= 1),
  digest           text        CHECK (digest IS NULL OR digest ~ '^sha256:[0-9a-f]{64}$'),
  outcome          text        NOT NULL CHECK (outcome IN ('CLAIMED', 'REPLAYED', 'REFUSED')),
  receipt_id       uuid,
  refusal_codes    text[]      NOT NULL DEFAULT '{}',
  correlation_id   uuid        NOT NULL,
  evaluated_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT authorized_action_attempts_evaluated_ms CHECK (evaluated_at = date_trunc('milliseconds', evaluated_at)),
  CONSTRAINT authorized_action_attempts_refusal_codes CHECK (
    (outcome = 'REFUSED' AND cardinality(refusal_codes) > 0) OR (outcome <> 'REFUSED' AND cardinality(refusal_codes) = 0)
  ),
  CONSTRAINT authorized_action_attempts_bounded CHECK (cardinality(refusal_codes) <= 64)
);

COMMENT ON TABLE business_operations.authorized_action_intake_attempts IS
  'Append-only log of every package intake evaluation (CLAIMED, REPLAYED or REFUSED with its refusal codes). Preserves refusal reasons; no foreign key into ABA.';

CREATE INDEX IF NOT EXISTS authorized_action_receipts_business_idx
  ON business_operations.authorized_action_receipts (tenant_id, workspace_id, business_id, received_at DESC);
CREATE INDEX IF NOT EXISTS authorized_action_attempts_business_idx
  ON business_operations.authorized_action_intake_attempts (tenant_id, workspace_id, business_id, evaluated_at DESC);

-- ── insert guards: the database clock stamps every fact; a claim must be valid against its receipt now ───────────────
CREATE OR REPLACE FUNCTION business_operations.guard_authorized_action_receipt_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.received_at := date_trunc('milliseconds', clock_timestamp());
  IF NEW.validated_at > NEW.received_at THEN
    RAISE EXCEPTION 'authorized_action_receipts: validated_at cannot be after the database clock'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_authorized_action_receipt_insert ON business_operations.authorized_action_receipts;
CREATE TRIGGER guard_authorized_action_receipt_insert
  BEFORE INSERT ON business_operations.authorized_action_receipts
  FOR EACH ROW EXECUTE FUNCTION business_operations.guard_authorized_action_receipt_insert();

CREATE OR REPLACE FUNCTION business_operations.guard_authorized_action_claim_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  r RECORD;
  now_ts timestamptz;
  expiry_state text;
  window_state text;
BEGIN
  SELECT digest, package, received_at INTO r FROM business_operations.authorized_action_receipts WHERE id = NEW.receipt_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'authorized_action_claims: the receipt does not exist' USING ERRCODE = 'check_violation';
  END IF;
  IF r.digest IS DISTINCT FROM NEW.digest THEN
    RAISE EXCEPTION 'authorized_action_claims: the claim digest does not match the receipt' USING ERRCODE = 'check_violation';
  END IF;

  now_ts := date_trunc('milliseconds', clock_timestamp());
  NEW.claimed_at := now_ts;
  IF NEW.status_verified_at > now_ts THEN
    RAISE EXCEPTION 'authorized_action_claims: the status answer is from the future' USING ERRCODE = 'check_violation';
  END IF;

  -- Defence in depth: whatever the caller decided, an expired package or a window that has not opened is never claimable.
  expiry_state := r.package #>> '{validity,expiresAt,state}';
  IF expiry_state = 'VALUE' AND (r.package #>> '{validity,expiresAt,value}')::timestamptz <= now_ts THEN
    RAISE EXCEPTION 'authorized_action_claims: the package has expired' USING ERRCODE = 'check_violation';
  END IF;
  window_state := r.package #>> '{action,executionWindow,state}';
  IF window_state = 'VALUE' AND (r.package #>> '{action,executionWindow,value,startsAt}')::timestamptz > now_ts THEN
    RAISE EXCEPTION 'authorized_action_claims: the execution window has not opened' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_authorized_action_claim_insert ON business_operations.authorized_action_claims;
CREATE TRIGGER guard_authorized_action_claim_insert
  BEFORE INSERT ON business_operations.authorized_action_claims
  FOR EACH ROW EXECUTE FUNCTION business_operations.guard_authorized_action_claim_insert();

CREATE OR REPLACE FUNCTION business_operations.guard_authorized_action_attempt_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.evaluated_at := date_trunc('milliseconds', clock_timestamp());
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_authorized_action_attempt_insert ON business_operations.authorized_action_intake_attempts;
CREATE TRIGGER guard_authorized_action_attempt_insert
  BEFORE INSERT ON business_operations.authorized_action_intake_attempts
  FOR EACH ROW EXECUTE FUNCTION business_operations.guard_authorized_action_attempt_insert();

-- ── append-only: UPDATE and DELETE are rejected unconditionally ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION business_operations.forbid_authorized_action_intake_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'business_operations.%: append-only table - % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['authorized_action_receipts', 'authorized_action_claims', 'authorized_action_intake_attempts'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS forbid_mutation_%1$s ON business_operations.%1$I', t);
    EXECUTE format('CREATE TRIGGER forbid_mutation_%1$s BEFORE UPDATE OR DELETE ON business_operations.%1$I FOR EACH ROW EXECUTE FUNCTION business_operations.forbid_authorized_action_intake_mutation()', t);
    EXECUTE format('DROP TRIGGER IF EXISTS forbid_truncate_%1$s ON business_operations.%1$I', t);
    EXECUTE format('CREATE TRIGGER forbid_truncate_%1$s BEFORE TRUNCATE ON business_operations.%1$I FOR EACH STATEMENT EXECUTE FUNCTION business_operations.forbid_authorized_action_intake_mutation()', t);
  END LOOP;
END $$;

-- ── RLS: tenant + workspace, forced, null-safe fail-closed (same predicate as every business_operations table) ───────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['authorized_action_receipts', 'authorized_action_claims', 'authorized_action_intake_attempts'] LOOP
    EXECUTE format('ALTER TABLE business_operations.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE business_operations.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON business_operations.%I', t || '_isolation', t);
    EXECUTE format(
      'CREATE POLICY %I ON business_operations.%I USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid AND workspace_id = current_setting(''app.workspace_id'', true)::uuid)',
      t || '_isolation', t
    );
  END LOOP;
END $$;

INSERT INTO _migrations (filename) VALUES ('0180_create_bo_authorized_action_intake.sql')
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
