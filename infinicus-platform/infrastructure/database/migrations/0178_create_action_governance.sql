-- Migration: 0178_create_action_governance
-- P0-5 Block 3c-2 (owner-authorised): the ABA-governed action-type registry and the automation-level policy store.
--
-- Locked chain (unchanged):  ADI -> ABA -> AuthorizedActionPackage -> BO execution -> ExecutionEvidence -> OM -> CL
--
-- Owner rulings R-1 and R-3 and the Block 1 reconciliation: ABA governs authorization semantics. An action-type
-- definition declares, for one (code, schemaVersion), which target kinds and parameters exist, what each parameter may
-- hold, which governance dimensions each parameter influences (R-7), and which governed fields may legitimately be
-- NOT_APPLICABLE (D-6). The automation-level policy is the governed, versioned source of `action.automationLevel.policy`
-- and of which recognized levels may currently be issued. "BO can execute this" stays a Business Operations fact (its own
-- capability registry); nothing here reaches BO.
--
-- Five append-only, RLS-forced tables in approved_business_action, scoped to tenant + workspace (the platform's tenant
-- isolation doctrine: no persistent table without it):
--   action_type_definitions                       immutable definition per (code, schema version); a change is a NEW schema version
--   action_type_status_events                     ACTIVE | RETIRED facts; no event = DRAFT (not usable); state is DERIVED
--   automation_level_policies                     the governed policy identity (one automation level per policy)
--   automation_level_policy_versions              immutable versions of a policy (the `policyVersionId` the package cites)
--   automation_level_policy_enablement_events     ENABLED | DISABLED facts; no event = NOT enabled
--
-- NO DATA IS SEEDED. The owner has not supplied a vocabulary and none is invented: until action types are defined and
-- activated, and a Level 2 policy is enabled, nothing can be issued. Enabling is restricted to Level 2 here (the scope
-- this block was authorised for); Levels 3 and 4 are recognized and can be defined, but cannot be enabled until the
-- rule-authorization provenance sources exist and the owner authorises it (ruling 12.1, P-5).
--
-- Deliberately NOT in this migration: execution-boundary authoring (3c-3), the issuer, the BO receipt/capability
-- registry, event emission, any wiring into the approval route, and any change to the 0176/0177 tables.

BEGIN;

-- ── action-type definition validator (mirrors the contract's validateActionTypeContract, plus strict shapes) ────────
-- Returns every problem found (empty = well formed). Pure and immutable so it can be unit-tested directly.
CREATE OR REPLACE FUNCTION approved_business_action.aap_action_type_problems(
  p_code text, p_schema_version text, p_target_kinds jsonb, p_parameters jsonb, p_impact jsonb, p_applicability jsonb
) RETURNS text[] LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  problems text[] := ARRAY[]::text[];
  dims text[] := ARRAY['SIMULATION','RISK','CONSTRAINTS','VALIDITY','RESOURCE_REQUIREMENTS','COST','REVERSIBILITY','EXPECTED_OUTCOME'];
  rule_keys text[] := ARRAY['executionWindow','preconditions','budget','rollback','monitoring','validityBound'];
  param_types text[] := ARRAY['string','integer','number','decimal_string','boolean','enum','identifier'];
  k text;
  spec jsonb;
  t text;
  extra text;
  allowed text[];
  el jsonb;
  n integer;
BEGIN
  IF p_code IS NULL OR p_code !~ '^[a-z][a-z0-9_]*$' OR length(p_code) > 100 THEN
    problems := array_append(problems, 'code must match [a-z][a-z0-9_]*'::text);
  END IF;
  IF p_schema_version IS NULL OR p_schema_version !~ '^[0-9]+(\.[0-9]+)*$' OR length(p_schema_version) > 50 THEN
    problems := array_append(problems, 'schemaVersion must be dotted numeric'::text);
  END IF;

  -- target kinds: a non-empty array of unique, non-blank strings
  IF jsonb_typeof(p_target_kinds) IS DISTINCT FROM 'array' OR jsonb_array_length(p_target_kinds) < 1 THEN
    problems := array_append(problems, 'at least one target kind is required'::text);
  ELSE
    FOR el IN SELECT value FROM jsonb_array_elements(p_target_kinds) LOOP
      IF jsonb_typeof(el) IS DISTINCT FROM 'string' OR NOT approved_business_action.aap_nonblank(el #>> '{}', 100) THEN
        problems := array_append(problems, 'every target kind must be a non-blank string (<= 100 characters)'::text);
        EXIT;
      END IF;
    END LOOP;
    IF (SELECT count(DISTINCT value) FROM jsonb_array_elements(p_target_kinds)) <> jsonb_array_length(p_target_kinds) THEN
      problems := array_append(problems, 'target kinds must be unique'::text);
    END IF;
  END IF;

  -- parameters: a non-empty object of well-formed specs
  IF jsonb_typeof(p_parameters) IS DISTINCT FROM 'object' OR p_parameters = '{}'::jsonb THEN
    problems := array_append(problems, 'at least one parameter is required'::text);
  ELSE
    FOR k, spec IN SELECT key, value FROM jsonb_each(p_parameters) LOOP
      IF k !~ '^[A-Za-z][A-Za-z0-9_]*$' OR length(k) > 100 THEN
        problems := array_append(problems, format('parameter name %s is invalid', k)::text);
      END IF;
      IF jsonb_typeof(spec) IS DISTINCT FROM 'object' THEN
        problems := array_append(problems, format('parameter %s must be a spec object', k)::text);
        CONTINUE;
      END IF;
      t := spec ->> 'type';
      IF t IS NULL OR NOT (t = ANY (param_types)) THEN
        problems := array_append(problems, format('parameter %s has an unknown type', k)::text);
        CONTINUE;
      END IF;
      IF jsonb_typeof(spec -> 'required') IS DISTINCT FROM 'boolean' THEN
        problems := array_append(problems, format('parameter %s needs a boolean required flag', k)::text);
      END IF;
      allowed := CASE t
        WHEN 'string' THEN ARRAY['type','required','maxLength']
        WHEN 'integer' THEN ARRAY['type','required','min','max']
        WHEN 'number' THEN ARRAY['type','required','min','max']
        WHEN 'enum' THEN ARRAY['type','required','values']
        ELSE ARRAY['type','required']
      END;
      FOR extra IN SELECT jsonb_object_keys(spec) LOOP
        IF NOT (extra = ANY (allowed)) THEN
          problems := array_append(problems, format('parameter %s declares an unknown property %s for type %s', k, extra, t)::text);
        END IF;
      END LOOP;
      IF t = 'enum' THEN
        IF jsonb_typeof(spec -> 'values') IS DISTINCT FROM 'array' OR jsonb_array_length(spec -> 'values') = 0 THEN
          problems := array_append(problems, format('enum %s needs unique values', k)::text);
        ELSE
          IF EXISTS (SELECT 1 FROM jsonb_array_elements(spec -> 'values') e WHERE jsonb_typeof(e) IS DISTINCT FROM 'string')
             OR (SELECT count(DISTINCT value) FROM jsonb_array_elements(spec -> 'values')) <> jsonb_array_length(spec -> 'values') THEN
            problems := array_append(problems, format('enum %s needs unique values', k)::text);
          END IF;
        END IF;
      END IF;
      IF t = 'string' AND spec ? 'maxLength' THEN
        IF jsonb_typeof(spec -> 'maxLength') IS DISTINCT FROM 'number' OR (spec ->> 'maxLength')::numeric < 1
           OR (spec ->> 'maxLength')::numeric <> trunc((spec ->> 'maxLength')::numeric) THEN
          problems := array_append(problems, format('maxLength for %s must be an integer >= 1', k)::text);
        END IF;
      END IF;
      IF t IN ('integer', 'number') THEN
        FOREACH extra IN ARRAY ARRAY['min', 'max'] LOOP
          IF spec ? extra THEN
            IF jsonb_typeof(spec -> extra) IS DISTINCT FROM 'number' THEN
              problems := array_append(problems, format('%s for %s must be a number', extra, k)::text);
            ELSIF t = 'integer' AND (spec ->> extra)::numeric <> trunc((spec ->> extra)::numeric) THEN
              problems := array_append(problems, format('%s for %s must be an integer', extra, k)::text);
            END IF;
          END IF;
        END LOOP;
        IF jsonb_typeof(spec -> 'min') = 'number' AND jsonb_typeof(spec -> 'max') = 'number'
           AND (spec ->> 'min')::numeric > (spec ->> 'max')::numeric THEN
          problems := array_append(problems, format('range for %s is empty', k)::text);
        END IF;
      END IF;
    END LOOP;
  END IF;

  -- governance impact: parameter -> known dimensions. A declared empty list means "influences no dimension".
  IF jsonb_typeof(p_impact) IS DISTINCT FROM 'object' THEN
    problems := array_append(problems, 'governanceImpact must be an object'::text);
  ELSE
    FOR k, spec IN SELECT key, value FROM jsonb_each(p_impact) LOOP
      IF jsonb_typeof(p_parameters) IS DISTINCT FROM 'object' OR NOT (p_parameters ? k) THEN
        problems := array_append(problems, format('governanceImpact references undeclared parameter %s', k)::text);
      END IF;
      IF jsonb_typeof(spec) IS DISTINCT FROM 'array' THEN
        problems := array_append(problems, format('governanceImpact for %s must be an array of dimensions', k)::text);
      ELSE
        FOR el IN SELECT value FROM jsonb_array_elements(spec) LOOP
          IF jsonb_typeof(el) IS DISTINCT FROM 'string' OR NOT ((el #>> '{}') = ANY (dims)) THEN
            problems := array_append(problems, format('unknown governance dimension for %s', k)::text);
            EXIT;
          END IF;
        END LOOP;
      END IF;
    END LOOP;
  END IF;

  -- applicability: only the governed fields, REQUIRED or NOT_APPLICABLE_ALLOWED. Anything unlisted is REQUIRED (fail closed).
  IF jsonb_typeof(p_applicability) IS DISTINCT FROM 'object' THEN
    problems := array_append(problems, 'applicability must be an object'::text);
  ELSE
    FOR k, spec IN SELECT key, value FROM jsonb_each(p_applicability) LOOP
      IF NOT (k = ANY (rule_keys)) THEN
        problems := array_append(problems, format('applicability references unknown field %s', k)::text);
      END IF;
      IF jsonb_typeof(spec) IS DISTINCT FROM 'string' OR NOT ((spec #>> '{}') IN ('REQUIRED', 'NOT_APPLICABLE_ALLOWED')) THEN
        problems := array_append(problems, format('applicability rule for %s is invalid', k)::text);
      END IF;
    END LOOP;
  END IF;

  RETURN problems;
END;
$$;

COMMENT ON FUNCTION approved_business_action.aap_action_type_problems(text, text, jsonb, jsonb, jsonb, jsonb) IS
  'Structural problems with an action-type definition (empty = well formed). Mirrors the aap/1 contract validateActionTypeContract and is checked against the same golden cases.';

-- ── action_type_definitions ────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS approved_business_action.action_type_definitions (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid        NOT NULL REFERENCES tenancy.tenants(id)    ON DELETE RESTRICT,
  workspace_id       uuid        NOT NULL REFERENCES tenancy.workspaces(id) ON DELETE RESTRICT,
  code               text        NOT NULL,
  schema_version     text        NOT NULL,
  -- Target kinds this action may address.
  target_kinds       jsonb       NOT NULL,
  -- parameter name -> ParameterSpec. The only parameters this action type accepts; undeclared parameters are rejected.
  parameters         jsonb       NOT NULL,
  -- parameter -> governance dimensions it influences (R-7). A parameter ABSENT here has UNKNOWN impact (treated as every dimension).
  governance_impact  jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- governed field -> REQUIRED | NOT_APPLICABLE_ALLOWED. Unlisted = REQUIRED.
  applicability      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  defined_by_user_id uuid        NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  correlation_id     uuid        NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT action_type_definitions_key UNIQUE (tenant_id, workspace_id, code, schema_version),
  CONSTRAINT action_type_definitions_scope_key UNIQUE (id, tenant_id, workspace_id),
  CONSTRAINT action_type_definitions_well_formed CHECK (
    cardinality(approved_business_action.aap_action_type_problems(code, schema_version, target_kinds, parameters, governance_impact, applicability)) = 0
  ),
  CONSTRAINT action_type_definitions_bounded CHECK (
    octet_length(parameters::text) <= 65536 AND octet_length(governance_impact::text) <= 16384
    AND octet_length(applicability::text) <= 4096 AND octet_length(target_kinds::text) <= 4096
  ),
  CONSTRAINT action_type_definitions_ms CHECK (created_at = date_trunc('milliseconds', created_at))
);

COMMENT ON TABLE approved_business_action.action_type_definitions IS
  'Append-only. The ABA-governed action-type definition for one (code, schema version). A change to any part is a NEW schema version, never an edit. "Valid authorized action" is ABA''s fact; "BO can execute it" stays a Business Operations fact.';

-- ── action_type_status_events ──────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS approved_business_action.action_type_status_events (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid        NOT NULL,
  workspace_id   uuid        NOT NULL,
  definition_id  uuid        NOT NULL,
  state          text        NOT NULL CHECK (state IN ('ACTIVE', 'RETIRED')),
  actor_user_id  uuid        NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  reason         text        CHECK (reason IS NULL OR (length(btrim(reason)) > 0 AND length(reason) <= 1000)),
  occurred_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  correlation_id uuid        NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT action_type_status_events_definition_fk
    FOREIGN KEY (definition_id, tenant_id, workspace_id)
    REFERENCES approved_business_action.action_type_definitions (id, tenant_id, workspace_id) ON DELETE RESTRICT,
  -- Retiring is an explicit, reasoned decision.
  CONSTRAINT action_type_status_events_retired_reason CHECK (state <> 'RETIRED' OR reason IS NOT NULL)
);

COMMENT ON TABLE approved_business_action.action_type_status_events IS
  'Append-only. ACTIVE then (at most once) RETIRED. A definition with no event is DRAFT and cannot be used. Re-activation is not possible: a corrected definition is a new schema version.';

CREATE UNIQUE INDEX IF NOT EXISTS action_type_status_events_one_active_idx
  ON approved_business_action.action_type_status_events (definition_id) WHERE state = 'ACTIVE';
CREATE UNIQUE INDEX IF NOT EXISTS action_type_status_events_one_retired_idx
  ON approved_business_action.action_type_status_events (definition_id) WHERE state = 'RETIRED';

-- ── automation_level_policies ──────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS approved_business_action.automation_level_policies (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid        NOT NULL REFERENCES tenancy.tenants(id)    ON DELETE RESTRICT,
  workspace_id      uuid        NOT NULL REFERENCES tenancy.workspaces(id) ON DELETE RESTRICT,
  policy_code       text        NOT NULL CHECK (policy_code ~ '^[a-z][a-z0-9_]*$' AND length(policy_code) <= 100),
  -- Level 0 (observe) and 1 (recommend) do not authorize execution and are not representable. Level 4 is recognized.
  automation_level  smallint    NOT NULL CHECK (automation_level IN (2, 3, 4)),
  created_by_user_id uuid       NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  correlation_id    uuid        NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT automation_level_policies_code_unique UNIQUE (tenant_id, workspace_id, policy_code),
  CONSTRAINT automation_level_policies_scope_key UNIQUE (id, tenant_id, workspace_id),
  CONSTRAINT automation_level_policies_level_key UNIQUE (id, automation_level),
  CONSTRAINT automation_level_policies_ms CHECK (created_at = date_trunc('milliseconds', created_at))
);

COMMENT ON TABLE approved_business_action.automation_level_policies IS
  'Append-only. The governed ABA policy identity that a package cites as action.automationLevel.policy.policyId. One automation level per policy.';

-- ── automation_level_policy_versions ───────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS approved_business_action.automation_level_policy_versions (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid        NOT NULL,
  workspace_id       uuid        NOT NULL,
  policy_id          uuid        NOT NULL,
  automation_level   smallint    NOT NULL,
  version_number     integer     NOT NULL CHECK (version_number >= 1),
  supersedes_version integer,
  description        text        NOT NULL CHECK (length(btrim(description)) > 0 AND length(description) <= 2000),
  specification      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id uuid        NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  correlation_id     uuid        NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT automation_level_policy_versions_policy_fk
    FOREIGN KEY (policy_id, tenant_id, workspace_id)
    REFERENCES approved_business_action.automation_level_policies (id, tenant_id, workspace_id) ON DELETE RESTRICT,
  -- The version carries its policy's level so enablement can be guarded without a join race; it must agree with the policy.
  CONSTRAINT automation_level_policy_versions_level_fk
    FOREIGN KEY (policy_id, automation_level)
    REFERENCES approved_business_action.automation_level_policies (id, automation_level) ON DELETE RESTRICT,
  CONSTRAINT automation_level_policy_versions_key UNIQUE (policy_id, version_number),
  CONSTRAINT automation_level_policy_versions_scope_key UNIQUE (id, tenant_id, workspace_id),
  CONSTRAINT automation_level_policy_versions_supersedes_fk
    FOREIGN KEY (policy_id, supersedes_version)
    REFERENCES approved_business_action.automation_level_policy_versions (policy_id, version_number) ON DELETE RESTRICT,
  CONSTRAINT automation_level_policy_versions_chain CHECK (
    (version_number = 1 AND supersedes_version IS NULL)
    OR (version_number > 1 AND supersedes_version IS NOT NULL AND supersedes_version = version_number - 1)
  ),
  CONSTRAINT automation_level_policy_versions_spec_object CHECK (
    jsonb_typeof(specification) = 'object' AND octet_length(specification::text) <= 65536
  ),
  CONSTRAINT automation_level_policy_versions_ms CHECK (created_at = date_trunc('milliseconds', created_at))
);

COMMENT ON TABLE approved_business_action.automation_level_policy_versions IS
  'Append-only linear version chain of a policy. A package cites (policy id, version id); a changed policy is a new version, never an edit.';

-- ── automation_level_policy_enablement_events ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS approved_business_action.automation_level_policy_enablement_events (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid        NOT NULL,
  workspace_id      uuid        NOT NULL,
  policy_version_id uuid        NOT NULL,
  state             text        NOT NULL CHECK (state IN ('ENABLED', 'DISABLED')),
  actor_user_id     uuid        NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  reason            text        NOT NULL CHECK (length(btrim(reason)) > 0 AND length(reason) <= 1000),
  occurred_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  correlation_id    uuid        NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT automation_level_policy_enablement_version_fk
    FOREIGN KEY (policy_version_id, tenant_id, workspace_id)
    REFERENCES approved_business_action.automation_level_policy_versions (id, tenant_id, workspace_id) ON DELETE RESTRICT
);

COMMENT ON TABLE approved_business_action.automation_level_policy_enablement_events IS
  'Append-only. Whether a policy version currently authorizes issuance at its level: the latest event wins, and no event means NOT enabled. At most one version per (scope, level) is enabled at a time; this migration permits enabling Level 2 only.';

-- ── indexes ────────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS action_type_definitions_scope_idx ON approved_business_action.action_type_definitions (tenant_id, workspace_id, code);
CREATE INDEX IF NOT EXISTS action_type_status_events_definition_idx ON approved_business_action.action_type_status_events (definition_id, occurred_at);
CREATE INDEX IF NOT EXISTS automation_level_policies_scope_idx ON approved_business_action.automation_level_policies (tenant_id, workspace_id, automation_level);
CREATE INDEX IF NOT EXISTS automation_level_policy_versions_policy_idx ON approved_business_action.automation_level_policy_versions (policy_id, version_number DESC);
CREATE INDEX IF NOT EXISTS automation_level_policy_enablement_version_idx ON approved_business_action.automation_level_policy_enablement_events (policy_version_id, occurred_at DESC, created_at DESC);

-- ── RLS (same fail-closed predicate as 0105) and append-only (0106 function) ───────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'action_type_definitions', 'action_type_status_events', 'automation_level_policies',
    'automation_level_policy_versions', 'automation_level_policy_enablement_events'
  ] LOOP
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

-- ── guards ─────────────────────────────────────────────────────────────────────────────────────────────────────────
-- Definitions: stamp the clock. (Shape is enforced by the well-formed CHECK so it also holds for any future writer.)
CREATE OR REPLACE FUNCTION approved_business_action.guard_action_type_definition_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  problems text[];
BEGIN
  problems := approved_business_action.aap_action_type_problems(NEW.code, NEW.schema_version, NEW.target_kinds, NEW.parameters, NEW.governance_impact, NEW.applicability);
  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'action_type_definitions: invalid definition: %', array_to_string(problems, '; ') USING ERRCODE = 'check_violation';
  END IF;
  NEW.created_at := date_trunc('milliseconds', clock_timestamp());
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_action_type_definition_insert ON approved_business_action.action_type_definitions;
CREATE TRIGGER guard_action_type_definition_insert
  BEFORE INSERT ON approved_business_action.action_type_definitions
  FOR EACH ROW EXECUTE FUNCTION approved_business_action.guard_action_type_definition_insert();

-- Status events: database clock, legal transitions only.
CREATE OR REPLACE FUNCTION approved_business_action.guard_action_type_status_event_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.occurred_at := clock_timestamp();
  PERFORM pg_advisory_xact_lock(hashtextextended('action_type_status:' || NEW.definition_id::text, 0));
  IF NEW.state = 'RETIRED' AND NOT EXISTS (
    SELECT 1 FROM approved_business_action.action_type_status_events e WHERE e.definition_id = NEW.definition_id AND e.state = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'action_type_status_events: only an ACTIVE action type can be retired' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state = 'ACTIVE' AND EXISTS (
    SELECT 1 FROM approved_business_action.action_type_status_events e WHERE e.definition_id = NEW.definition_id
  ) THEN
    RAISE EXCEPTION 'action_type_status_events: an action type is activated once; a corrected definition is a new schema version' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_action_type_status_event_insert ON approved_business_action.action_type_status_events;
CREATE TRIGGER guard_action_type_status_event_insert
  BEFORE INSERT ON approved_business_action.action_type_status_events
  FOR EACH ROW EXECUTE FUNCTION approved_business_action.guard_action_type_status_event_insert();

-- Policies and versions: database clock.
CREATE OR REPLACE FUNCTION approved_business_action.guard_automation_policy_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.created_at := date_trunc('milliseconds', clock_timestamp());
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_automation_level_policies_insert ON approved_business_action.automation_level_policies;
CREATE TRIGGER guard_automation_level_policies_insert
  BEFORE INSERT ON approved_business_action.automation_level_policies
  FOR EACH ROW EXECUTE FUNCTION approved_business_action.guard_automation_policy_insert();

DROP TRIGGER IF EXISTS guard_automation_level_policy_versions_insert ON approved_business_action.automation_level_policy_versions;
CREATE TRIGGER guard_automation_level_policy_versions_insert
  BEFORE INSERT ON approved_business_action.automation_level_policy_versions
  FOR EACH ROW EXECUTE FUNCTION approved_business_action.guard_automation_policy_insert();

-- Enablement: database clock; Level 2 only; the latest version of its policy; one enabled version per (scope, level).
CREATE OR REPLACE FUNCTION approved_business_action.guard_automation_policy_enablement_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v RECORD;
  latest integer;
  current_state text;
BEGIN
  SELECT policy_id, automation_level, version_number INTO v
    FROM approved_business_action.automation_level_policy_versions WHERE id = NEW.policy_version_id;
  NEW.occurred_at := clock_timestamp();
  -- Serialize every enablement decision for this scope + level so "one enabled version" cannot race.
  PERFORM pg_advisory_xact_lock(hashtextextended('automation_policy_enablement:' || NEW.tenant_id::text || ':' || NEW.workspace_id::text || ':' || v.automation_level::text, 0));

  SELECT e.state INTO current_state FROM approved_business_action.automation_level_policy_enablement_events e
   WHERE e.policy_version_id = NEW.policy_version_id ORDER BY e.occurred_at DESC, e.created_at DESC, e.id DESC LIMIT 1;

  IF NEW.state = 'ENABLED' THEN
    IF v.automation_level <> 2 THEN
      RAISE EXCEPTION 'automation_level_policy_enablement_events: only Level 2 can be enabled (Level % is recognized but NOT_ENABLED until the rule-authorization sources exist and the owner authorises it)', v.automation_level
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT max(version_number) INTO latest FROM approved_business_action.automation_level_policy_versions WHERE policy_id = v.policy_id;
    IF v.version_number <> latest THEN
      RAISE EXCEPTION 'automation_level_policy_enablement_events: only the latest version of a policy can be enabled' USING ERRCODE = 'check_violation';
    END IF;
    IF current_state = 'ENABLED' THEN
      RAISE EXCEPTION 'automation_level_policy_enablement_events: the policy version is already enabled' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (
      SELECT 1
        FROM approved_business_action.automation_level_policy_versions pv
       WHERE pv.tenant_id = NEW.tenant_id AND pv.workspace_id = NEW.workspace_id AND pv.automation_level = v.automation_level
         AND pv.id <> NEW.policy_version_id
         AND (SELECT e.state FROM approved_business_action.automation_level_policy_enablement_events e
               WHERE e.policy_version_id = pv.id ORDER BY e.occurred_at DESC, e.created_at DESC, e.id DESC LIMIT 1) = 'ENABLED'
    ) THEN
      RAISE EXCEPTION 'automation_level_policy_enablement_events: another policy version is already enabled for Level % in this scope; disable it first', v.automation_level
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF current_state IS DISTINCT FROM 'ENABLED' THEN
      RAISE EXCEPTION 'automation_level_policy_enablement_events: only an enabled policy version can be disabled' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_automation_policy_enablement_insert ON approved_business_action.automation_level_policy_enablement_events;
CREATE TRIGGER guard_automation_policy_enablement_insert
  BEFORE INSERT ON approved_business_action.automation_level_policy_enablement_events
  FOR EACH ROW EXECUTE FUNCTION approved_business_action.guard_automation_policy_enablement_insert();

INSERT INTO _migrations (filename) VALUES ('0178_create_action_governance.sql')
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
