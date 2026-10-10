-- Migration: 0176_create_authorized_action_packages
-- P0-5 Block 3a (owner-authorised): persistence for the ABA-owned AuthorizedActionPackage.
--
-- Locked chain (unchanged):  ADI -> ABA -> AuthorizedActionPackage -> BO execution -> ExecutionEvidence -> OM -> CL
--
-- ABA is the source of truth for what was formally authorized (ABA spec 35). This migration only STORES the sealed,
-- immutable package that the pure contract (@infinicus/handoff-contracts, aap/1) defines. It creates no execution
-- path, no BO table, no ABA->BO wiring, no event emission and no data. ApprovedAction is not execution authority and is
-- not repurposed (owner ruling D-4).
--
-- Three tables in approved_business_action (owner ruling R-9), all RLS-confined to tenant + workspace and append-only:
--   authorized_action_packages               header: stable identity of one authorized action's package. No mutable status.
--   authorized_action_package_versions       the sealed package (full contract document + digest). Never edited.
--   authorized_action_package_lifecycle_events  ISSUED | REVOKED | SUPERSEDED | EXPIRED | CONSUMED facts. State is DERIVED
--                                            from this record and the database clock; it is never a column.
--
-- Database guards are defence in depth (R-8). The application issuer remains the only intended writer; the DB makes
-- the hard invariants impossible to violate even by a faulty writer. The digest is TAMPER EVIDENCE ONLY: the database
-- checks that the stored columns agree with the stored document, the application validator recomputes the digest.
--
-- Deliberately NOT in this migration (need their own authorisation and number): structured authorized-action capture
-- (original/delta/final parameters, owner assignment), the BO intake/consumption receipt in business_operations, the
-- automation/rule policy sources, and the ACTION_AUTHORIZED event contract registration.

BEGIN;

-- ── header ─────────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS approved_business_action.authorized_action_packages (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL REFERENCES tenancy.tenants(id)     ON DELETE RESTRICT,
  workspace_id uuid        NOT NULL REFERENCES tenancy.workspaces(id)  ON DELETE RESTRICT,
  business_id  uuid        NOT NULL REFERENCES platform.businesses(id) ON DELETE RESTRICT,
  action_id    uuid        NOT NULL REFERENCES approved_business_action.approved_actions(id)   ON DELETE RESTRICT,
  decision_id  uuid        NOT NULL REFERENCES approved_business_action.approval_decisions(id) ON DELETE RESTRICT,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- One stable package identity per authorized action; supersession adds a VERSION, never a second header.
  CONSTRAINT authorized_action_packages_action_unique UNIQUE (action_id),
  CONSTRAINT authorized_action_packages_scope_key UNIQUE (id, tenant_id, workspace_id, business_id)
);

COMMENT ON TABLE approved_business_action.authorized_action_packages IS
  'Append-only. Stable identity of the AuthorizedActionPackage for one authorized action. Carries no status: lifecycle is derived from authorized_action_package_lifecycle_events and the database clock. Distinct from approved_actions (owner ruling D-4).';

-- ── versions (the sealed package) ──────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS approved_business_action.authorized_action_package_versions (
  id                          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   uuid        NOT NULL,
  workspace_id                uuid        NOT NULL,
  business_id                 uuid        NOT NULL,
  package_id                  uuid        NOT NULL,
  package_version             integer     NOT NULL CHECK (package_version >= 1),
  supersedes_package_version  integer,
  action_version_id           uuid        NOT NULL REFERENCES approved_business_action.approved_action_versions(id) ON DELETE RESTRICT,
  contract_version            text        NOT NULL CHECK (contract_version = 'aap/1'),
  canonical_version           text        NOT NULL CHECK (canonical_version = 'aap-canonical/1'),
  digest_algorithm            text        NOT NULL CHECK (digest_algorithm = 'sha256'),
  digest                      text        NOT NULL CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  -- Level 0/1 do not authorize execution and are not representable. Level 4 is representable; whether it is ENABLED
  -- is a policy fact enforced by the issuer and BO, not frozen into the schema.
  automation_level            smallint    NOT NULL CHECK (automation_level IN (2, 3, 4)),
  authorization_mode          text        NOT NULL CHECK (authorization_mode IN ('HUMAN_APPROVAL', 'RULE_AUTHORIZED')),
  issuer_component            text        NOT NULL CHECK (length(btrim(issuer_component)) > 0),
  issued_at                   timestamptz NOT NULL,
  expires_at                  timestamptz,
  correlation_id              uuid        NOT NULL,
  causation_id                uuid        NOT NULL,
  package                     jsonb       NOT NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT authorized_action_package_versions_package_fk
    FOREIGN KEY (package_id, tenant_id, workspace_id, business_id)
    REFERENCES approved_business_action.authorized_action_packages (id, tenant_id, workspace_id, business_id)
    ON DELETE RESTRICT,
  CONSTRAINT authorized_action_package_versions_key UNIQUE (package_id, package_version),
  CONSTRAINT authorized_action_package_versions_scope_key
    UNIQUE (package_id, package_version, tenant_id, workspace_id, business_id),
  CONSTRAINT authorized_action_package_versions_digest_unique UNIQUE (tenant_id, workspace_id, digest),
  -- Supersession is a linear chain inside one header: version N+1 supersedes version N, and version 1 supersedes nothing.
  CONSTRAINT authorized_action_package_versions_supersedes_fk
    FOREIGN KEY (package_id, supersedes_package_version)
    REFERENCES approved_business_action.authorized_action_package_versions (package_id, package_version)
    ON DELETE RESTRICT,
  CONSTRAINT authorized_action_package_versions_supersedes_chain CHECK (
    (package_version = 1 AND supersedes_package_version IS NULL)
    OR (package_version > 1 AND supersedes_package_version IS NOT NULL AND supersedes_package_version = package_version - 1)
  ),
  -- Level 2 is human approval; Level 3/4 are rule-authorized. A mismatch is never storable (contract: AUTHORIZATION_MODE_MISMATCH).
  CONSTRAINT authorized_action_package_versions_mode_matches_level CHECK (
    (automation_level = 2) = (authorization_mode = 'HUMAN_APPROVAL')
  ),
  CONSTRAINT authorized_action_package_versions_issued_ms CHECK (issued_at = date_trunc('milliseconds', issued_at)),
  CONSTRAINT authorized_action_package_versions_expiry_ms CHECK (expires_at IS NULL OR expires_at = date_trunc('milliseconds', expires_at)),
  CONSTRAINT authorized_action_package_versions_expiry_after_issue CHECK (expires_at IS NULL OR expires_at > issued_at),

  -- The stored columns must agree with the sealed document. The document is the authority; the columns are a queryable copy.
  CONSTRAINT authorized_action_package_versions_document_is_object CHECK (jsonb_typeof(package) = 'object'),
  CONSTRAINT authorized_action_package_versions_document_identity CHECK (
    (package #>> '{contractVersion}')                    IS NOT DISTINCT FROM contract_version
    AND (package #>> '{identity,packageId}')             IS NOT DISTINCT FROM package_id::text
    AND (package #>> '{identity,packageVersion}')        IS NOT DISTINCT FROM package_version::text
    AND (package #>> '{scope,tenantId}')                 IS NOT DISTINCT FROM tenant_id::text
    AND (package #>> '{scope,workspaceId}')              IS NOT DISTINCT FROM workspace_id::text
    AND (package #>> '{scope,businessId}')               IS NOT DISTINCT FROM business_id::text
    AND (package #>> '{action,actionVersionId}')         IS NOT DISTINCT FROM action_version_id::text
    AND (package #>> '{action,automationLevel,level}')   IS NOT DISTINCT FROM automation_level::text
    AND (package #>> '{authorization,mode}')             IS NOT DISTINCT FROM authorization_mode
    AND (package #>> '{issuance,issuerComponent}')       IS NOT DISTINCT FROM issuer_component
    AND (package #>> '{issuance,issuedAt}')              IS NOT DISTINCT FROM to_char(issued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    AND (package #>> '{trace,correlationId}')            IS NOT DISTINCT FROM correlation_id::text
    AND (package #>> '{trace,causationId}')              IS NOT DISTINCT FROM causation_id::text
    AND (package #>> '{integrity,canonicalVersion}')     IS NOT DISTINCT FROM canonical_version
    AND (package #>> '{integrity,algorithm}')            IS NOT DISTINCT FROM digest_algorithm
    AND (package #>> '{integrity,digest}')               IS NOT DISTINCT FROM digest
    AND (package #>> '{consumption,mode}')               IS NOT DISTINCT FROM 'SINGLE_USE'
  ),
  CONSTRAINT authorized_action_package_versions_document_supersedes CHECK (
    CASE WHEN supersedes_package_version IS NULL
      THEN jsonb_typeof(package #> '{identity,supersedes}') IS NOT DISTINCT FROM 'null'
      ELSE (package #>> '{identity,supersedes,packageId}') IS NOT DISTINCT FROM package_id::text
        AND (package #>> '{identity,supersedes,packageVersion}') IS NOT DISTINCT FROM supersedes_package_version::text
    END
  ),
  -- Expiry: NOT_APPLICABLE <=> NULL column; VALUE <=> the same instant. UNAVAILABLE is never storable.
  CONSTRAINT authorized_action_package_versions_document_expiry CHECK (
    CASE package #>> '{validity,expiresAt,state}'
      WHEN 'VALUE' THEN expires_at IS NOT NULL
        AND (package #>> '{validity,expiresAt,value}') IS NOT DISTINCT FROM to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      WHEN 'NOT_APPLICABLE' THEN expires_at IS NULL
      ELSE false
    END
  ),
  -- A package never outlives the decision it derives from (R-6).
  CONSTRAINT authorized_action_package_versions_expiry_within_decision CHECK (
    CASE WHEN package #>> '{validity,decisionValidUntil,state}' = 'VALUE'
      THEN expires_at IS NOT NULL
        AND expires_at <= (package #>> '{validity,decisionValidUntil,value}')::timestamptz
      ELSE true
    END
  )
);

COMMENT ON TABLE approved_business_action.authorized_action_package_versions IS
  'Append-only. The sealed AuthorizedActionPackage (aap/1) exactly as issued, with its digest. Never edited: revocation, supersession and consumption are lifecycle events. The digest is tamper evidence only (it does not replace RBAC, approval provenance or BO re-validation).';
COMMENT ON COLUMN approved_business_action.authorized_action_package_versions.package IS
  'The complete sealed contract document. The columns on this row are a queryable copy checked against it.';

-- ── lifecycle events ───────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS approved_business_action.authorized_action_package_lifecycle_events (
  id                           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                    uuid        NOT NULL,
  workspace_id                 uuid        NOT NULL,
  business_id                  uuid        NOT NULL,
  package_id                   uuid        NOT NULL,
  package_version              integer     NOT NULL,
  state                        text        NOT NULL CHECK (state IN ('ISSUED', 'REVOKED', 'SUPERSEDED', 'EXPIRED', 'CONSUMED')),
  occurred_at                  timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_type                   text        CHECK (actor_type IS NULL OR actor_type IN ('user', 'service', 'system')),
  actor_id                     text,
  reason                       text,
  correlation_id               uuid        NOT NULL,
  causation_id                 uuid,
  superseded_by_package_version integer,
  -- Soft reference to the BO intake/consumption receipt (the receipt table is a later, separately authorised migration).
  consumption_receipt_id       uuid,
  audit_event_id               uuid        REFERENCES approved_business_action.approval_audit_events(id) ON DELETE RESTRICT,
  created_at                   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT authorized_action_package_lifecycle_version_fk
    FOREIGN KEY (package_id, package_version, tenant_id, workspace_id, business_id)
    REFERENCES approved_business_action.authorized_action_package_versions (package_id, package_version, tenant_id, workspace_id, business_id)
    ON DELETE RESTRICT,
  CONSTRAINT authorized_action_package_lifecycle_superseded_by_fk
    FOREIGN KEY (package_id, superseded_by_package_version)
    REFERENCES approved_business_action.authorized_action_package_versions (package_id, package_version)
    ON DELETE RESTRICT,
  CONSTRAINT authorized_action_package_lifecycle_actor_pair CHECK (
    (actor_type IS NULL AND actor_id IS NULL) OR (actor_type IS NOT NULL AND actor_id IS NOT NULL AND length(btrim(actor_id)) > 0)
  ),
  CONSTRAINT authorized_action_package_lifecycle_superseded_shape CHECK (
    (state = 'SUPERSEDED') = (superseded_by_package_version IS NOT NULL)
    AND (state <> 'SUPERSEDED' OR superseded_by_package_version = package_version + 1)
  ),
  CONSTRAINT authorized_action_package_lifecycle_consumed_shape CHECK (
    (state = 'CONSUMED') = (consumption_receipt_id IS NOT NULL)
  ),
  -- A revocation is an explicit, attributable, reasoned decision. Nothing else may carry a revocation.
  CONSTRAINT authorized_action_package_lifecycle_revoked_shape CHECK (
    state <> 'REVOKED' OR (actor_type IS NOT NULL AND reason IS NOT NULL AND length(btrim(reason)) > 0)
  )
);

COMMENT ON TABLE approved_business_action.authorized_action_package_lifecycle_events IS
  'Append-only lifecycle facts for a package version. EXECUTED is deliberately not a state (execution truth belongs to BO / ExecutionEvidence); EXECUTABLE is derived, never stored. occurred_at is forced to the database clock. At most one terminal event (REVOKED | SUPERSEDED | EXPIRED | CONSUMED) per version; revoking after consumption is a BO stop instruction, not a state change (owner ruling R-5).';

-- Exactly one ISSUED per version, and at most one terminal event per version (races cannot produce two).
CREATE UNIQUE INDEX IF NOT EXISTS authorized_action_package_lifecycle_one_issued_idx
  ON approved_business_action.authorized_action_package_lifecycle_events (package_id, package_version)
  WHERE state = 'ISSUED';
CREATE UNIQUE INDEX IF NOT EXISTS authorized_action_package_lifecycle_one_terminal_idx
  ON approved_business_action.authorized_action_package_lifecycle_events (package_id, package_version)
  WHERE state <> 'ISSUED';

-- ── indexes ────────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS authorized_action_packages_scope_idx
  ON approved_business_action.authorized_action_packages (tenant_id, workspace_id, business_id);
CREATE INDEX IF NOT EXISTS authorized_action_packages_decision_idx
  ON approved_business_action.authorized_action_packages (decision_id);
CREATE INDEX IF NOT EXISTS authorized_action_package_versions_action_version_idx
  ON approved_business_action.authorized_action_package_versions (action_version_id);
CREATE INDEX IF NOT EXISTS authorized_action_package_versions_expiry_idx
  ON approved_business_action.authorized_action_package_versions (tenant_id, workspace_id, expires_at)
  WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS authorized_action_package_lifecycle_version_idx
  ON approved_business_action.authorized_action_package_lifecycle_events (package_id, package_version, occurred_at);
CREATE INDEX IF NOT EXISTS authorized_action_package_lifecycle_scope_idx
  ON approved_business_action.authorized_action_package_lifecycle_events (tenant_id, workspace_id, occurred_at DESC);

-- ── RLS: tenant + workspace, forced, null-safe fail-closed (same predicate as 0105) ─────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'authorized_action_packages',
    'authorized_action_package_versions',
    'authorized_action_package_lifecycle_events'
  ] LOOP
    EXECUTE format('ALTER TABLE approved_business_action.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE approved_business_action.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON approved_business_action.%I', t || '_tenant_isolation', t);
    EXECUTE format(
      'CREATE POLICY %I ON approved_business_action.%I USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid AND workspace_id = current_setting(''app.workspace_id'', true)::uuid)',
      t || '_tenant_isolation', t
    );
  END LOOP;
END $$;

-- ── append-only: UPDATE and DELETE are rejected unconditionally (reuses the schema guard from 0106) ───────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'authorized_action_packages',
    'authorized_action_package_versions',
    'authorized_action_package_lifecycle_events'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS forbid_mutation_%1$s ON approved_business_action.%1$s', t);
    EXECUTE format(
      'CREATE TRIGGER forbid_mutation_%1$s BEFORE UPDATE OR DELETE ON approved_business_action.%1$s FOR EACH ROW EXECUTE FUNCTION approved_business_action.forbid_mutation()',
      t
    );
  END LOOP;
END $$;

-- ── header guard: the package must belong to the decision that authorized the action ───────────────────────────────
CREATE OR REPLACE FUNCTION approved_business_action.guard_authorized_action_package_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  a RECORD;
BEGIN
  SELECT decision_id, tenant_id, workspace_id, business_id INTO a
    FROM approved_business_action.approved_actions WHERE id = NEW.action_id;
  IF NOT FOUND
     OR a.decision_id IS DISTINCT FROM NEW.decision_id
     OR a.tenant_id IS DISTINCT FROM NEW.tenant_id
     OR a.workspace_id IS DISTINCT FROM NEW.workspace_id
     OR a.business_id IS DISTINCT FROM NEW.business_id THEN
    RAISE EXCEPTION 'authorized_action_packages: action/decision/scope do not match the authorized action'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_authorized_action_package_insert ON approved_business_action.authorized_action_packages;
CREATE TRIGGER guard_authorized_action_package_insert
  BEFORE INSERT ON approved_business_action.authorized_action_packages
  FOR EACH ROW EXECUTE FUNCTION approved_business_action.guard_authorized_action_package_insert();

-- ── version guard: issuance must verify the decision; lineage must agree with the header ───────────────────────────
CREATE OR REPLACE FUNCTION approved_business_action.guard_authorized_action_package_version_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  h RECORD;
  d RECORD;
  v RECORD;
BEGIN
  SELECT action_id, decision_id INTO h
    FROM approved_business_action.authorized_action_packages WHERE id = NEW.package_id;

  -- The action version must be a version of the header's authorized action.
  IF NOT EXISTS (
    SELECT 1 FROM approved_business_action.approved_action_versions av
     WHERE av.id = NEW.action_version_id AND av.action_id = h.action_id
  ) OR NEW.package #>> '{action,actionId}' IS DISTINCT FROM h.action_id::text
    OR NEW.package #>> '{lineage,decision,decisionId}' IS DISTINCT FROM h.decision_id::text THEN
    RAISE EXCEPTION 'authorized_action_package_versions: action version or lineage does not match the package header'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Issuance must verify the decision (handoff invariant 1): a human-approved package needs an approved decision, and
  -- the document must state exactly that status. Rule-authorized packages carry no human decision status.
  SELECT status INTO d FROM approved_business_action.approval_decisions WHERE id = h.decision_id;
  IF NEW.authorization_mode = 'HUMAN_APPROVAL' THEN
    IF d.status IS NULL OR d.status NOT IN ('approved', 'approved_with_modifications')
       OR NEW.package #>> '{authorization,decisionStatus}' IS DISTINCT FROM d.status THEN
      RAISE EXCEPTION 'authorized_action_package_versions: the decision is not approved (status %)', coalesce(d.status, 'missing')
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- A package version can only supersede a version that has no terminal lifecycle fact yet (ISSUED -> SUPERSEDED only).
  IF NEW.supersedes_package_version IS NOT NULL THEN
    SELECT state INTO v FROM approved_business_action.authorized_action_package_lifecycle_events
     WHERE package_id = NEW.package_id AND package_version = NEW.supersedes_package_version AND state <> 'ISSUED';
    IF FOUND THEN
      RAISE EXCEPTION 'authorized_action_package_versions: version % already has terminal state %', NEW.supersedes_package_version, v.state
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_authorized_action_package_version_insert ON approved_business_action.authorized_action_package_versions;
CREATE TRIGGER guard_authorized_action_package_version_insert
  BEFORE INSERT ON approved_business_action.authorized_action_package_versions
  FOR EACH ROW EXECUTE FUNCTION approved_business_action.guard_authorized_action_package_version_insert();

-- ── every version is born with its ISSUED fact; a successor atomically supersedes its predecessor ───────────────────
CREATE OR REPLACE FUNCTION approved_business_action.record_authorized_action_package_issue()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO approved_business_action.authorized_action_package_lifecycle_events
    (tenant_id, workspace_id, business_id, package_id, package_version, state, occurred_at,
     actor_type, actor_id, correlation_id, causation_id)
  VALUES
    (NEW.tenant_id, NEW.workspace_id, NEW.business_id, NEW.package_id, NEW.package_version, 'ISSUED', NEW.issued_at,
     'service', NEW.issuer_component, NEW.correlation_id, NEW.causation_id);

  IF NEW.supersedes_package_version IS NOT NULL THEN
    INSERT INTO approved_business_action.authorized_action_package_lifecycle_events
      (tenant_id, workspace_id, business_id, package_id, package_version, state,
       actor_type, actor_id, reason, correlation_id, causation_id, superseded_by_package_version)
    VALUES
      (NEW.tenant_id, NEW.workspace_id, NEW.business_id, NEW.package_id, NEW.supersedes_package_version, 'SUPERSEDED',
       'service', NEW.issuer_component, 'superseded by package version ' || NEW.package_version,
       NEW.correlation_id, NEW.causation_id, NEW.package_version);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS record_authorized_action_package_issue ON approved_business_action.authorized_action_package_versions;
CREATE TRIGGER record_authorized_action_package_issue
  AFTER INSERT ON approved_business_action.authorized_action_package_versions
  FOR EACH ROW EXECUTE FUNCTION approved_business_action.record_authorized_action_package_issue();

-- ── lifecycle guard: database clock only, legal transitions only ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION approved_business_action.guard_authorized_action_package_lifecycle_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v RECORD;
  now_ts timestamptz;
BEGIN
  SELECT expires_at, issued_at INTO v
    FROM approved_business_action.authorized_action_package_versions
   WHERE package_id = NEW.package_id AND package_version = NEW.package_version;

  IF NEW.state = 'ISSUED' THEN
    -- Only the version insert trigger writes ISSUED, at the version's own issuance instant.
    NEW.occurred_at := v.issued_at;
    RETURN NEW;
  END IF;

  -- Facts are stamped with the database clock; a writer cannot backdate or postdate them.
  now_ts := clock_timestamp();
  NEW.occurred_at := now_ts;

  IF NOT EXISTS (
    SELECT 1 FROM approved_business_action.authorized_action_package_lifecycle_events e
     WHERE e.package_id = NEW.package_id AND e.package_version = NEW.package_version AND e.state = 'ISSUED'
  ) THEN
    RAISE EXCEPTION 'authorized_action_package_lifecycle_events: % requires an ISSUED package version', NEW.state
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.state = 'EXPIRED' AND (v.expires_at IS NULL OR now_ts < v.expires_at) THEN
    RAISE EXCEPTION 'authorized_action_package_lifecycle_events: EXPIRED cannot be recorded before the package expiry (database clock)'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Consumption is a single-use claim and can never be recorded for a package that has already expired.
  IF NEW.state = 'CONSUMED' AND v.expires_at IS NOT NULL AND now_ts >= v.expires_at THEN
    RAISE EXCEPTION 'authorized_action_package_lifecycle_events: an expired package cannot be consumed'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_authorized_action_package_lifecycle_insert ON approved_business_action.authorized_action_package_lifecycle_events;
CREATE TRIGGER guard_authorized_action_package_lifecycle_insert
  BEFORE INSERT ON approved_business_action.authorized_action_package_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION approved_business_action.guard_authorized_action_package_lifecycle_insert();

INSERT INTO _migrations (filename) VALUES ('0176_create_authorized_action_packages.sql')
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
