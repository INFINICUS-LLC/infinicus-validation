-- Migration: 0177_create_authorized_action_capture
-- P0-5 Block 3c-1 (owner-authorised): structured authorized-action capture and accountable-owner assignment.
--
-- Locked chain (unchanged):  ADI -> ABA -> AuthorizedActionPackage -> BO execution -> ExecutionEvidence -> OM -> CL
--
-- Owner ruling D-1/D-2 and the Block 1 reconciliation (5.2): ABA persists, at decision time and immutably,
--   (1) the original proposed parameter set (or a governed NOT_APPLICABLE),
--   (2) the structured modification delta + reason,
--   (3) the complete FINAL effective authorized parameter set.
-- The package copies (3) and references (1) and (2); Business Operations never computes (3) from (1) + (2).
-- `approval_decision_modifications` (text only, never written by the live flow) cannot hold this and is left alone.
--
-- Owner ruling R-2: Identity/Tenancy remain the truth for WHO the owner is. ABA stores only the assignment and its
-- provenance (who assigned, when, role, due date, escalation) and references the owner by user id + membership id.
--
-- Two append-only, RLS-forced tables in approved_business_action (R-9):
--   authorized_action_captures                one immutable capture per authorized action (the decision-time record)
--   authorized_action_owner_assignments       linear version chain per authorized action (re-assignment = new version)
--
-- The documents use the same Governed shapes as the aap/1 contract (VALUE | NOT_APPLICABLE with a reason). The database
-- re-derives the final parameter set from the original and the delta, so a capture whose final set is not exactly
-- "original with the recorded delta applied" can never be stored (contract: MODIFICATION_LINEAGE_INCONSISTENT).
--
-- Deliberately NOT in this migration: the governed action vocabulary and its parameter schemas (3c-2), the automation
-- policy, execution window / preconditions / rollback / budget / monitoring authoring (3c-3), the package issuer,
-- the BO receipt, and any wiring into the approval route. No data is written; there is no backfill.

BEGIN;

-- ── helpers (pure, immutable) ─────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION approved_business_action.aap_is_uuid(v text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT v IS NOT NULL AND v ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
$$;

CREATE OR REPLACE FUNCTION approved_business_action.aap_is_ms_utc(v text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT v IS NOT NULL AND v ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
$$;

CREATE OR REPLACE FUNCTION approved_business_action.aap_nonblank(v text, max_len integer)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT v IS NOT NULL AND length(btrim(v)) > 0 AND length(v) <= max_len
$$;

-- A governed NOT_APPLICABLE carries a code and a statement; "no source found" is never a reason.
CREATE OR REPLACE FUNCTION approved_business_action.aap_valid_not_applicable(g jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_typeof(g -> 'reason') = 'object'
     AND approved_business_action.aap_nonblank(g #>> '{reason,code}', 100)
     AND approved_business_action.aap_nonblank(g #>> '{reason,statement}', 1000)
$$;

-- Applies a structured delta to the original parameter set. Mirrors the contract rules exactly; any violation raises.
--   ADD    parameter absent from the original; `after` only
--   SET    parameter present; `before` equals the original value; `after` differs
--   REMOVE parameter present; `before` equals the original value; no `after`
-- A parameter may be changed once.
CREATE OR REPLACE FUNCTION approved_business_action.aap_apply_changes(original jsonb, changes jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  working jsonb := original;
  seen text[] := ARRAY[]::text[];
  ch jsonb;
  p text;
  op text;
  had boolean;
BEGIN
  IF jsonb_typeof(original) IS DISTINCT FROM 'object' OR jsonb_typeof(changes) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'aap_apply_changes: original must be an object and changes an array' USING ERRCODE = 'check_violation';
  END IF;
  FOR ch IN SELECT value FROM jsonb_array_elements(changes) LOOP
    IF jsonb_typeof(ch) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'aap_apply_changes: every change must be an object' USING ERRCODE = 'check_violation';
    END IF;
    p := ch ->> 'parameter';
    op := ch ->> 'operation';
    IF NOT approved_business_action.aap_nonblank(p, 200) THEN
      RAISE EXCEPTION 'aap_apply_changes: a change needs a parameter name (1-200 characters)' USING ERRCODE = 'check_violation';
    END IF;
    IF p = ANY (seen) THEN
      RAISE EXCEPTION 'aap_apply_changes: parameter % is changed more than once', p USING ERRCODE = 'check_violation';
    END IF;
    seen := seen || p;
    had := original ? p;
    IF op = 'ADD' THEN
      IF had OR (ch ? 'before') OR NOT (ch ? 'after') THEN
        RAISE EXCEPTION 'aap_apply_changes: ADD of % requires a parameter absent from the original and an after value only', p USING ERRCODE = 'check_violation';
      END IF;
      working := working || jsonb_build_object(p, ch -> 'after');
    ELSIF op = 'REMOVE' THEN
      IF NOT had OR NOT (ch ? 'before') OR (ch ? 'after') OR (ch -> 'before') IS DISTINCT FROM (original -> p) THEN
        RAISE EXCEPTION 'aap_apply_changes: REMOVE of % requires the original value as before and no after', p USING ERRCODE = 'check_violation';
      END IF;
      working := working - p;
    ELSIF op = 'SET' THEN
      IF NOT had OR NOT (ch ? 'before') OR NOT (ch ? 'after') OR (ch -> 'before') IS DISTINCT FROM (original -> p) THEN
        RAISE EXCEPTION 'aap_apply_changes: SET of % requires the original value as before and a new after', p USING ERRCODE = 'check_violation';
      END IF;
      IF (ch -> 'before') IS NOT DISTINCT FROM (ch -> 'after') THEN
        RAISE EXCEPTION 'aap_apply_changes: SET of % must change the value', p USING ERRCODE = 'check_violation';
      END IF;
      working := working || jsonb_build_object(p, ch -> 'after');
    ELSE
      RAISE EXCEPTION 'aap_apply_changes: unknown operation %', coalesce(op, '(missing)') USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN working;
END;
$$;

-- ── authorized_action_captures ─────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS approved_business_action.authorized_action_captures (
  id                         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                  uuid        NOT NULL REFERENCES tenancy.tenants(id)     ON DELETE RESTRICT,
  workspace_id               uuid        NOT NULL REFERENCES tenancy.workspaces(id)  ON DELETE RESTRICT,
  business_id                uuid        NOT NULL REFERENCES platform.businesses(id) ON DELETE RESTRICT,
  action_id                  uuid        NOT NULL REFERENCES approved_business_action.approved_actions(id)         ON DELETE RESTRICT,
  decision_id                uuid        NOT NULL REFERENCES approved_business_action.approval_decisions(id)       ON DELETE RESTRICT,
  decision_version_id        uuid        NOT NULL REFERENCES approved_business_action.approval_decision_versions(id) ON DELETE RESTRICT,
  -- Copy of the decision status at capture time; the guard checks it against the decision itself.
  decision_status            text        NOT NULL CHECK (decision_status IN ('approved', 'approved_with_modifications')),
  -- Reference into the ABA-governed vocabulary (the registry arrives in 3c-2, so this is a soft reference for now).
  action_type_code           text        NOT NULL CHECK (length(btrim(action_type_code)) > 0 AND length(action_type_code) <= 100),
  action_type_schema_version text        NOT NULL CHECK (action_type_schema_version ~ '^[0-9]+(\.[0-9]+)*$' AND length(action_type_schema_version) <= 50),
  target_kind                text        NOT NULL CHECK (length(btrim(target_kind)) > 0 AND length(target_kind) <= 100),
  target_id                  text        NOT NULL CHECK (length(btrim(target_id)) > 0 AND length(target_id) <= 200),
  -- Governed<ProposedParameters>: { state: VALUE, value: { source: { layer: 'ADI', recordType, recordId }, parameters } }
  proposed                   jsonb       NOT NULL,
  -- Governed<Modification>: { state: VALUE, value: { reason, modifiedByUserId, modifiedAt, changes[] } }
  modification               jsonb       NOT NULL,
  -- Governed<ModificationEvaluation>: fresh governance evidence for an execution-affecting modification (recorded, not decided, here).
  modification_evaluation    jsonb       NOT NULL,
  -- The complete effective authorized parameter set. BO executes this and nothing else.
  final_parameters           jsonb       NOT NULL,
  captured_by_user_id        uuid        NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  captured_at                timestamptz NOT NULL DEFAULT clock_timestamp(),
  correlation_id             uuid        NOT NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT authorized_action_captures_action_unique UNIQUE (action_id),
  CONSTRAINT authorized_action_captures_scope_key UNIQUE (id, tenant_id, workspace_id, business_id),
  CONSTRAINT authorized_action_captures_json_shapes CHECK (
    jsonb_typeof(proposed) = 'object' AND jsonb_typeof(modification) = 'object'
    AND jsonb_typeof(modification_evaluation) = 'object' AND jsonb_typeof(final_parameters) = 'object'
  ),
  -- Bounded: a parameter set is configuration, not a document store.
  CONSTRAINT authorized_action_captures_bounded CHECK (
    octet_length(final_parameters::text) <= 65536 AND octet_length(proposed::text) <= 131072
    AND octet_length(modification::text) <= 131072 AND octet_length(modification_evaluation::text) <= 65536
  ),
  CONSTRAINT authorized_action_captures_ms CHECK (captured_at = date_trunc('milliseconds', captured_at))
);

COMMENT ON TABLE approved_business_action.authorized_action_captures IS
  'Append-only. One immutable decision-time capture per authorized action: original proposed parameters, structured modification delta, and the complete final effective parameter set that ABA authorized. The final set is re-derived from the original and the delta by the database. Distinct from approval_decision_modifications (text only, unwritten).';

-- ── authorized_action_owner_assignments ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS approved_business_action.authorized_action_owner_assignments (
  id                           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                    uuid        NOT NULL REFERENCES tenancy.tenants(id)     ON DELETE RESTRICT,
  workspace_id                 uuid        NOT NULL REFERENCES tenancy.workspaces(id)  ON DELETE RESTRICT,
  business_id                  uuid        NOT NULL REFERENCES platform.businesses(id) ON DELETE RESTRICT,
  action_id                    uuid        NOT NULL REFERENCES approved_business_action.approved_actions(id) ON DELETE RESTRICT,
  assignment_version           integer     NOT NULL CHECK (assignment_version >= 1),
  -- Canonical identity truth (R-2): the owner is a real user with an active membership in this tenant and workspace.
  owner_user_id                uuid        NOT NULL REFERENCES identity.users(id)       ON DELETE RESTRICT,
  owner_membership_id          uuid        NOT NULL REFERENCES tenancy.memberships(id)  ON DELETE RESTRICT,
  role_code                    text        NOT NULL CHECK (length(btrim(role_code)) > 0 AND length(role_code) <= 100),
  assigned_by_user_id          uuid        NOT NULL REFERENCES identity.users(id)       ON DELETE RESTRICT,
  assigned_at                  timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- Governed<string> and Governed<{ref}>: exactly one of value / governed NOT_APPLICABLE reason.
  due_at                       timestamptz,
  due_not_applicable_reason    jsonb,
  escalation_policy_ref        text        CHECK (escalation_policy_ref IS NULL OR (length(btrim(escalation_policy_ref)) > 0 AND length(escalation_policy_ref) <= 200)),
  escalation_not_applicable_reason jsonb,
  supersedes_assignment_version integer,
  correlation_id               uuid        NOT NULL,
  created_at                   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT authorized_action_owner_assignments_key UNIQUE (action_id, assignment_version),
  CONSTRAINT authorized_action_owner_assignments_supersedes_fk
    FOREIGN KEY (action_id, supersedes_assignment_version)
    REFERENCES approved_business_action.authorized_action_owner_assignments (action_id, assignment_version) ON DELETE RESTRICT,
  CONSTRAINT authorized_action_owner_assignments_chain CHECK (
    (assignment_version = 1 AND supersedes_assignment_version IS NULL)
    OR (assignment_version > 1 AND supersedes_assignment_version IS NOT NULL AND supersedes_assignment_version = assignment_version - 1)
  ),
  CONSTRAINT authorized_action_owner_assignments_due_exactly_one CHECK ((due_at IS NOT NULL) <> (due_not_applicable_reason IS NOT NULL)),
  CONSTRAINT authorized_action_owner_assignments_escalation_exactly_one CHECK ((escalation_policy_ref IS NOT NULL) <> (escalation_not_applicable_reason IS NOT NULL)),
  CONSTRAINT authorized_action_owner_assignments_reason_shapes CHECK (
    (due_not_applicable_reason IS NULL OR (jsonb_typeof(due_not_applicable_reason) = 'object'
       AND approved_business_action.aap_nonblank(due_not_applicable_reason ->> 'code', 100)
       AND approved_business_action.aap_nonblank(due_not_applicable_reason ->> 'statement', 1000)))
    AND (escalation_not_applicable_reason IS NULL OR (jsonb_typeof(escalation_not_applicable_reason) = 'object'
       AND approved_business_action.aap_nonblank(escalation_not_applicable_reason ->> 'code', 100)
       AND approved_business_action.aap_nonblank(escalation_not_applicable_reason ->> 'statement', 1000)))
  ),
  CONSTRAINT authorized_action_owner_assignments_ms CHECK (
    assigned_at = date_trunc('milliseconds', assigned_at) AND (due_at IS NULL OR due_at = date_trunc('milliseconds', due_at))
  ),
  CONSTRAINT authorized_action_owner_assignments_due_after_assignment CHECK (due_at IS NULL OR due_at > assigned_at)
);

COMMENT ON TABLE approved_business_action.authorized_action_owner_assignments IS
  'Append-only linear version chain: the accountable owner of an authorized action. Identity/Tenancy stay the truth for who the owner is (user + active membership); ABA stores the assignment and its provenance. Re-assignment is a new version, never an edit.';

-- ── indexes ────────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS authorized_action_captures_scope_idx
  ON approved_business_action.authorized_action_captures (tenant_id, workspace_id, business_id);
CREATE INDEX IF NOT EXISTS authorized_action_captures_decision_idx
  ON approved_business_action.authorized_action_captures (decision_id);
CREATE INDEX IF NOT EXISTS authorized_action_owner_assignments_scope_idx
  ON approved_business_action.authorized_action_owner_assignments (tenant_id, workspace_id, business_id);
CREATE INDEX IF NOT EXISTS authorized_action_owner_assignments_owner_idx
  ON approved_business_action.authorized_action_owner_assignments (tenant_id, workspace_id, owner_user_id);

-- ── RLS (same fail-closed predicate as 0105) and append-only (0106 function) ───────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['authorized_action_captures', 'authorized_action_owner_assignments'] LOOP
    EXECUTE format('ALTER TABLE approved_business_action.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE approved_business_action.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON approved_business_action.%I', t || '_tenant_isolation', t);
    EXECUTE format(
      'CREATE POLICY %I ON approved_business_action.%I USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid AND workspace_id = current_setting(''app.workspace_id'', true)::uuid)',
      t || '_tenant_isolation', t
    );
    EXECUTE format('DROP TRIGGER IF EXISTS forbid_mutation_%1$s ON approved_business_action.%1$s', t);
    EXECUTE format(
      'CREATE TRIGGER forbid_mutation_%1$s BEFORE UPDATE OR DELETE ON approved_business_action.%1$s FOR EACH ROW EXECUTE FUNCTION approved_business_action.forbid_mutation()',
      t
    );
  END LOOP;
END $$;

-- ── capture guard: decision relationship, document shapes, delta arithmetic ────────────────────────────────────────
CREATE OR REPLACE FUNCTION approved_business_action.guard_authorized_action_capture_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  a RECORD;
  d RECORD;
  dv RECORD;
  proposed_state text := NEW.proposed ->> 'state';
  mod_state text := NEW.modification ->> 'state';
  eval_state text := NEW.modification_evaluation ->> 'state';
  original jsonb;
  ev jsonb;
  dims text[] := ARRAY['SIMULATION','RISK','CONSTRAINTS','VALIDITY','RESOURCE_REQUIREMENTS','COST','REVERSIBILITY','EXPECTED_OUTCOME'];
BEGIN
  -- The action must be the one the decision authorized, in the same scope.
  SELECT decision_id, tenant_id, workspace_id, business_id INTO a FROM approved_business_action.approved_actions WHERE id = NEW.action_id;
  IF NOT FOUND OR a.decision_id IS DISTINCT FROM NEW.decision_id
     OR a.tenant_id IS DISTINCT FROM NEW.tenant_id OR a.workspace_id IS DISTINCT FROM NEW.workspace_id OR a.business_id IS DISTINCT FROM NEW.business_id THEN
    RAISE EXCEPTION 'authorized_action_captures: action/decision/scope do not match the authorized action' USING ERRCODE = 'check_violation';
  END IF;

  -- The decision must be approved, and the capture must state exactly that status (issuance verifies the decision).
  SELECT status, tenant_id, workspace_id INTO d FROM approved_business_action.approval_decisions WHERE id = NEW.decision_id;
  IF d.status IS NULL OR d.status NOT IN ('approved', 'approved_with_modifications') OR d.status IS DISTINCT FROM NEW.decision_status THEN
    RAISE EXCEPTION 'authorized_action_captures: the decision is not approved with status % (status %)', NEW.decision_status, coalesce(d.status, 'missing')
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT decision_id INTO dv FROM approved_business_action.approval_decision_versions WHERE id = NEW.decision_version_id;
  IF NOT FOUND OR dv.decision_id IS DISTINCT FROM NEW.decision_id THEN
    RAISE EXCEPTION 'authorized_action_captures: the decision version does not belong to the decision' USING ERRCODE = 'check_violation';
  END IF;

  -- Facts are stamped with the database clock (millisecond precision); a writer cannot backdate a capture.
  NEW.captured_at := date_trunc('milliseconds', clock_timestamp());

  -- proposed: Governed<ProposedParameters>
  IF proposed_state = 'VALUE' THEN
    IF jsonb_typeof(NEW.proposed -> 'value') IS DISTINCT FROM 'object'
       OR (NEW.proposed #>> '{value,source,layer}') IS DISTINCT FROM 'ADI'
       OR NOT approved_business_action.aap_nonblank(NEW.proposed #>> '{value,source,recordType}', 200)
       OR NOT approved_business_action.aap_is_uuid(NEW.proposed #>> '{value,source,recordId}')
       OR jsonb_typeof(NEW.proposed #> '{value,parameters}') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'authorized_action_captures: proposed must carry an ADI source (record type + id) and a parameters object' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF proposed_state = 'NOT_APPLICABLE' THEN
    IF NOT approved_business_action.aap_valid_not_applicable(NEW.proposed) THEN
      RAISE EXCEPTION 'authorized_action_captures: a governed NOT_APPLICABLE needs a reason code and statement' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    RAISE EXCEPTION 'authorized_action_captures: proposed state must be VALUE or NOT_APPLICABLE (UNAVAILABLE is never storable)' USING ERRCODE = 'check_violation';
  END IF;

  -- modification: Governed<Modification>
  IF mod_state = 'VALUE' THEN
    IF jsonb_typeof(NEW.modification -> 'value') IS DISTINCT FROM 'object'
       OR NOT approved_business_action.aap_nonblank(NEW.modification #>> '{value,reason}', 4000)
       OR NOT approved_business_action.aap_is_uuid(NEW.modification #>> '{value,modifiedByUserId}')
       OR NOT approved_business_action.aap_is_ms_utc(NEW.modification #>> '{value,modifiedAt}')
       OR jsonb_typeof(NEW.modification #> '{value,changes}') IS DISTINCT FROM 'array'
       OR jsonb_array_length(NEW.modification #> '{value,changes}') < 1 THEN
      RAISE EXCEPTION 'authorized_action_captures: a modification needs a reason, a modifier, a millisecond timestamp and at least one change' USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW.modification #>> '{value,modifiedAt}')::timestamptz > NEW.captured_at THEN
      RAISE EXCEPTION 'authorized_action_captures: the modification is dated after the capture' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF mod_state = 'NOT_APPLICABLE' THEN
    IF NOT approved_business_action.aap_valid_not_applicable(NEW.modification) THEN
      RAISE EXCEPTION 'authorized_action_captures: a governed NOT_APPLICABLE needs a reason code and statement' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    RAISE EXCEPTION 'authorized_action_captures: modification state must be VALUE or NOT_APPLICABLE' USING ERRCODE = 'check_violation';
  END IF;

  -- modification evaluation: Governed<ModificationEvaluation>
  IF eval_state = 'VALUE' THEN
    IF (NEW.modification_evaluation #>> '{value,basis}') NOT IN ('DECLARED_IMPACT', 'CONSERVATIVE_FULL')
       OR jsonb_typeof(NEW.modification_evaluation #> '{value,evidence}') IS DISTINCT FROM 'array'
       OR jsonb_array_length(NEW.modification_evaluation #> '{value,evidence}') < 1 THEN
      RAISE EXCEPTION 'authorized_action_captures: an evaluation needs a basis and at least one piece of evidence' USING ERRCODE = 'check_violation';
    END IF;
    FOR ev IN SELECT value FROM jsonb_array_elements(NEW.modification_evaluation #> '{value,evidence}') LOOP
      IF jsonb_typeof(ev) IS DISTINCT FROM 'object'
         OR NOT ((ev ->> 'dimension') = ANY (dims))
         OR NOT approved_business_action.aap_is_ms_utc(ev ->> 'evaluatedAt')
         OR (ev ->> 'result') IS DISTINCT FROM 'PASSED'
         OR NOT approved_business_action.aap_nonblank(ev #>> '{evidenceRef,kind}', 200)
         OR NOT approved_business_action.aap_nonblank(ev #>> '{evidenceRef,id}', 200) THEN
        RAISE EXCEPTION 'authorized_action_captures: malformed governance evidence' USING ERRCODE = 'check_violation';
      END IF;
      IF mod_state = 'VALUE' AND (ev ->> 'evaluatedAt')::timestamptz < (NEW.modification #>> '{value,modifiedAt}')::timestamptz THEN
        RAISE EXCEPTION 'authorized_action_captures: an evaluation that predates the modification is not fresh' USING ERRCODE = 'check_violation';
      END IF;
    END LOOP;
  ELSIF eval_state = 'NOT_APPLICABLE' THEN
    IF NOT approved_business_action.aap_valid_not_applicable(NEW.modification_evaluation) THEN
      RAISE EXCEPTION 'authorized_action_captures: a governed NOT_APPLICABLE needs a reason code and statement' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    RAISE EXCEPTION 'authorized_action_captures: evaluation state must be VALUE or NOT_APPLICABLE' USING ERRCODE = 'check_violation';
  END IF;

  -- The final set is exactly what the decision status says it is.
  IF NEW.decision_status = 'approved' THEN
    IF mod_state = 'VALUE' OR eval_state = 'VALUE' THEN
      RAISE EXCEPTION 'authorized_action_captures: a plain approval carries no modification or evaluation' USING ERRCODE = 'check_violation';
    END IF;
    IF proposed_state = 'VALUE' AND (NEW.proposed #> '{value,parameters}') IS DISTINCT FROM NEW.final_parameters THEN
      RAISE EXCEPTION 'authorized_action_captures: a plain approval must authorize exactly the proposed parameters' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF mod_state <> 'VALUE' THEN
      RAISE EXCEPTION 'authorized_action_captures: approved_with_modifications requires a structured modification delta and reason' USING ERRCODE = 'check_violation';
    END IF;
    IF proposed_state <> 'VALUE' THEN
      RAISE EXCEPTION 'authorized_action_captures: a modification needs the original proposed parameter set it modifies' USING ERRCODE = 'check_violation';
    END IF;
    original := NEW.proposed #> '{value,parameters}';
    IF approved_business_action.aap_apply_changes(original, NEW.modification #> '{value,changes}') IS DISTINCT FROM NEW.final_parameters THEN
      RAISE EXCEPTION 'authorized_action_captures: the final parameters are not the original with the recorded delta applied' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_authorized_action_capture_insert ON approved_business_action.authorized_action_captures;
CREATE TRIGGER guard_authorized_action_capture_insert
  BEFORE INSERT ON approved_business_action.authorized_action_captures
  FOR EACH ROW EXECUTE FUNCTION approved_business_action.guard_authorized_action_capture_insert();

-- ── owner assignment guard: real user + active membership in this scope; database clock ────────────────────────────
CREATE OR REPLACE FUNCTION approved_business_action.guard_authorized_action_owner_assignment_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  a RECORD;
BEGIN
  SELECT tenant_id, workspace_id, business_id INTO a FROM approved_business_action.approved_actions WHERE id = NEW.action_id;
  IF NOT FOUND OR a.tenant_id IS DISTINCT FROM NEW.tenant_id OR a.workspace_id IS DISTINCT FROM NEW.workspace_id OR a.business_id IS DISTINCT FROM NEW.business_id THEN
    RAISE EXCEPTION 'authorized_action_owner_assignments: the action is not in this scope' USING ERRCODE = 'check_violation';
  END IF;

  -- Identity/Tenancy are the truth: the owner must be that user's ACTIVE membership in this tenant and workspace.
  IF NOT EXISTS (
    SELECT 1 FROM tenancy.memberships m
     WHERE m.id = NEW.owner_membership_id AND m.user_id = NEW.owner_user_id
       AND m.tenant_id = NEW.tenant_id AND m.workspace_id = NEW.workspace_id AND m.status = 'active'
  ) THEN
    RAISE EXCEPTION 'authorized_action_owner_assignments: the owner must hold an active membership in this tenant and workspace' USING ERRCODE = 'check_violation';
  END IF;

  -- Facts are stamped with the database clock (millisecond precision).
  NEW.assigned_at := date_trunc('milliseconds', clock_timestamp());
  IF NEW.due_at IS NOT NULL AND NEW.due_at <= NEW.assigned_at THEN
    RAISE EXCEPTION 'authorized_action_owner_assignments: the due date must be after the assignment' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_authorized_action_owner_assignment_insert ON approved_business_action.authorized_action_owner_assignments;
CREATE TRIGGER guard_authorized_action_owner_assignment_insert
  BEFORE INSERT ON approved_business_action.authorized_action_owner_assignments
  FOR EACH ROW EXECUTE FUNCTION approved_business_action.guard_authorized_action_owner_assignment_insert();

INSERT INTO _migrations (filename) VALUES ('0177_create_authorized_action_capture.sql')
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
