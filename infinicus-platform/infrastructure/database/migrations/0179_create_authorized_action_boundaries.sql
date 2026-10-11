-- Migration: 0179_create_authorized_action_boundaries
-- P0-5 Block 3c-3 (owner-authorised): the execution boundaries of an authorized action, and its simulation reference.
--
-- Locked chain (unchanged):  ADI -> ABA -> AuthorizedActionPackage -> BO execution -> ExecutionEvidence -> OM -> CL
--
-- Master Manifest 8.7 and ABA spec 14-16: an AuthorizedActionPackage carries the execution window, preconditions, budget,
-- rollback instructions and monitoring metrics, and (owner ruling D-6) the simulation run it was backed by - each either a
-- real value or a governed NOT_APPLICABLE with a reason. Their authoring path and the applicability rule that decides which
-- of them may be NOT_APPLICABLE (the action type's `applicability`, migration 0178) did not exist. This migration is that
-- source: a single append-only, RLS-forced table whose rows use exactly the Governed shapes of the aap/1 contract.
--
--   authorized_action_boundaries   linear version chain per authorized action (re-authoring a window, a budget or a
--                                  rollback plan is a NEW version, never an edit)
--
-- Database guards (second line behind the repository):
--   - the action must have its immutable capture (0177) and the capture's action type must be an ACTIVE definition (0178);
--   - every field has exactly the contract's shape (a shared golden-case file proves the database never accepts what the
--     contract rejects);
--   - a field may be NOT_APPLICABLE only where the action type's `applicability` says NOT_APPLICABLE_ALLOWED (anything
--     unlisted is REQUIRED: fail closed). UNAVAILABLE is never storable;
--   - the execution window ends after it starts; facts are stamped with the database clock.
--
-- The existing, never-populated tables (action_execution_windows, approved_action_steps, approved_action_constraints, ADI
-- monitoring requirements) are deliberately NOT reused: they hang off mutable plan headers and carry different semantics.
-- They are left untouched. The simulation reference is a soft uuid (no foreign key, no read of the simulation layer).
--
-- Deliberately NOT in this migration: the issuer, the BO receipt, event emission, any wiring into the approval route, any
-- change to the 0176-0178 tables, and any data. Nothing is seeded and there is no backfill.

BEGIN;

-- ── pure validators (immutable) ────────────────────────────────────────────────────────────────────────────────────
-- True when `obj` is an object whose keys include every `required` key and nothing outside required + optional.
CREATE OR REPLACE FUNCTION approved_business_action.aap_keys_within(obj jsonb, required text[], optional text[])
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  k text;
BEGIN
  IF jsonb_typeof(obj) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  FOREACH k IN ARRAY required LOOP
    IF NOT (obj ? k) THEN RETURN false; END IF;
  END LOOP;
  FOR k IN SELECT jsonb_object_keys(obj) LOOP
    IF NOT (k = ANY (required) OR k = ANY (optional)) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END;
$$;

-- The contract's NotApplicableReason: UPPER_SNAKE code, a statement, and an optional governed basis.
CREATE OR REPLACE FUNCTION approved_business_action.aap_valid_not_applicable_strict(g jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  r jsonb := g -> 'reason';
BEGIN
  IF NOT approved_business_action.aap_keys_within(g, ARRAY['state', 'reason'], ARRAY[]::text[]) THEN RETURN false; END IF;
  IF NOT approved_business_action.aap_keys_within(r, ARRAY['code', 'statement'], ARRAY['basis']) THEN RETURN false; END IF;
  IF jsonb_typeof(r -> 'code') IS DISTINCT FROM 'string' OR (r ->> 'code') !~ '^[A-Z][A-Z0-9_]*$' THEN RETURN false; END IF;
  IF jsonb_typeof(r -> 'statement') IS DISTINCT FROM 'string' OR NOT approved_business_action.aap_nonblank(r ->> 'statement', 2000) THEN RETURN false; END IF;
  IF r ? 'basis' THEN
    IF NOT approved_business_action.aap_keys_within(r -> 'basis', ARRAY['kind', 'ref'], ARRAY[]::text[]) THEN RETURN false; END IF;
    IF (r #>> '{basis,kind}') IS NULL OR NOT ((r #>> '{basis,kind}') IN ('ACTION_SCHEMA', 'POLICY')) THEN RETURN false; END IF;
    IF jsonb_typeof(r #> '{basis,ref}') IS DISTINCT FROM 'string' OR NOT approved_business_action.aap_nonblank(r #>> '{basis,ref}', 200) THEN RETURN false; END IF;
  END IF;
  RETURN true;
END;
$$;

-- 'VALUE' or 'NOT_APPLICABLE' for a well-formed governed envelope; NULL when the envelope is malformed (including UNAVAILABLE).
CREATE OR REPLACE FUNCTION approved_business_action.aap_governed_state(g jsonb)
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF jsonb_typeof(g) IS DISTINCT FROM 'object' THEN RETURN NULL; END IF;
  IF (g ->> 'state') = 'VALUE' AND approved_business_action.aap_keys_within(g, ARRAY['state', 'value'], ARRAY[]::text[]) THEN RETURN 'VALUE'; END IF;
  IF (g ->> 'state') = 'NOT_APPLICABLE' AND approved_business_action.aap_valid_not_applicable_strict(g) THEN RETURN 'NOT_APPLICABLE'; END IF;
  RETURN NULL;
END;
$$;

-- Every structural problem with the six governed boundary fields (empty = well formed). Mirrors the aap/1 contract.
CREATE OR REPLACE FUNCTION approved_business_action.aap_boundary_problems(
  p_window jsonb, p_preconditions jsonb, p_budget jsonb, p_rollback jsonb, p_monitoring jsonb, p_simulation jsonb
) RETURNS text[] LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  problems text[] := ARRAY[]::text[];
  v jsonb;
  el jsonb;
  ops text[] := ARRAY['eq','neq','lt','lte','gt','gte','between','in','not_in','contains'];
BEGIN
  -- execution window: { startsAt, endsAt | null }, ms-UTC timestamps, ending after it starts
  IF approved_business_action.aap_governed_state(p_window) IS NULL THEN
    problems := array_append(problems, 'executionWindow must be VALUE or a governed NOT_APPLICABLE'::text);
  ELSIF p_window ->> 'state' = 'VALUE' THEN
    v := p_window -> 'value';
    IF NOT approved_business_action.aap_keys_within(v, ARRAY['startsAt', 'endsAt'], ARRAY[]::text[])
       OR NOT approved_business_action.aap_is_ms_utc(v ->> 'startsAt')
       OR NOT (jsonb_typeof(v -> 'endsAt') = 'null' OR (jsonb_typeof(v -> 'endsAt') = 'string' AND approved_business_action.aap_is_ms_utc(v ->> 'endsAt'))) THEN
      problems := array_append(problems, 'executionWindow needs a millisecond startsAt and an endsAt that is null or a millisecond timestamp'::text);
    ELSIF jsonb_typeof(v -> 'endsAt') = 'string' AND (v ->> 'endsAt')::timestamptz <= (v ->> 'startsAt')::timestamptz THEN
      problems := array_append(problems, 'executionWindow must end after it starts'::text);
    END IF;
  END IF;

  -- preconditions: 1..500 of { code, operator, operand }
  IF approved_business_action.aap_governed_state(p_preconditions) IS NULL THEN
    problems := array_append(problems, 'preconditions must be VALUE or a governed NOT_APPLICABLE'::text);
  ELSIF p_preconditions ->> 'state' = 'VALUE' THEN
    v := p_preconditions -> 'value';
    IF jsonb_typeof(v) IS DISTINCT FROM 'array' OR jsonb_array_length(v) < 1 OR jsonb_array_length(v) > 500 THEN
      problems := array_append(problems, 'preconditions needs between 1 and 500 entries'::text);
    ELSE
      FOR el IN SELECT value FROM jsonb_array_elements(v) LOOP
        IF NOT approved_business_action.aap_keys_within(el, ARRAY['code', 'operator', 'operand'], ARRAY[]::text[])
           OR jsonb_typeof(el -> 'code') IS DISTINCT FROM 'string' OR NOT approved_business_action.aap_nonblank(el ->> 'code', 200)
           OR jsonb_typeof(el -> 'operator') IS DISTINCT FROM 'string' OR NOT ((el ->> 'operator') = ANY (ops)) THEN
          problems := array_append(problems, 'every precondition needs a code, a known operator and an operand'::text);
          EXIT;
        END IF;
      END LOOP;
    END IF;
  END IF;

  -- budget: { amount: non-negative decimal string, currency: ISO 4217 }
  IF approved_business_action.aap_governed_state(p_budget) IS NULL THEN
    problems := array_append(problems, 'budget must be VALUE or a governed NOT_APPLICABLE'::text);
  ELSIF p_budget ->> 'state' = 'VALUE' THEN
    v := p_budget -> 'value';
    IF NOT approved_business_action.aap_keys_within(v, ARRAY['amount', 'currency'], ARRAY[]::text[])
       OR jsonb_typeof(v -> 'amount') IS DISTINCT FROM 'string' OR (v ->> 'amount') !~ '^[0-9]+(\.[0-9]+)?$'
       OR jsonb_typeof(v -> 'currency') IS DISTINCT FROM 'string' OR (v ->> 'currency') !~ '^[A-Z]{3}$' THEN
      problems := array_append(problems, 'budget needs a non-negative decimal amount string and a three-letter currency code'::text);
    END IF;
  END IF;

  -- rollback: { instructions } (1..10000 characters)
  IF approved_business_action.aap_governed_state(p_rollback) IS NULL THEN
    problems := array_append(problems, 'rollback must be VALUE or a governed NOT_APPLICABLE'::text);
  ELSIF p_rollback ->> 'state' = 'VALUE' THEN
    v := p_rollback -> 'value';
    IF NOT approved_business_action.aap_keys_within(v, ARRAY['instructions'], ARRAY[]::text[])
       OR jsonb_typeof(v -> 'instructions') IS DISTINCT FROM 'string' OR NOT approved_business_action.aap_nonblank(v ->> 'instructions', 10000) THEN
      problems := array_append(problems, 'rollback needs non-blank instructions (at most 10000 characters)'::text);
    END IF;
  END IF;

  -- monitoring: { metrics: 1..500 of { metricCode, target (null | JSON), unit (null | string) } }
  IF approved_business_action.aap_governed_state(p_monitoring) IS NULL THEN
    problems := array_append(problems, 'monitoring must be VALUE or a governed NOT_APPLICABLE'::text);
  ELSIF p_monitoring ->> 'state' = 'VALUE' THEN
    v := p_monitoring -> 'value';
    IF NOT approved_business_action.aap_keys_within(v, ARRAY['metrics'], ARRAY[]::text[])
       OR jsonb_typeof(v -> 'metrics') IS DISTINCT FROM 'array' OR jsonb_array_length(v -> 'metrics') < 1 OR jsonb_array_length(v -> 'metrics') > 500 THEN
      problems := array_append(problems, 'monitoring needs between 1 and 500 metrics'::text);
    ELSE
      FOR el IN SELECT value FROM jsonb_array_elements(v -> 'metrics') LOOP
        IF NOT approved_business_action.aap_keys_within(el, ARRAY['metricCode', 'target', 'unit'], ARRAY[]::text[])
           OR jsonb_typeof(el -> 'metricCode') IS DISTINCT FROM 'string' OR NOT approved_business_action.aap_nonblank(el ->> 'metricCode', 200)
           OR NOT (jsonb_typeof(el -> 'unit') = 'null' OR (jsonb_typeof(el -> 'unit') = 'string' AND approved_business_action.aap_nonblank(el ->> 'unit', 50))) THEN
          problems := array_append(problems, 'every metric needs a metricCode, a target (null or a value) and a unit (null or text)'::text);
          EXIT;
        END IF;
      END LOOP;
    END IF;
  END IF;

  -- simulation run reference: a uuid, or a governed NOT_APPLICABLE (owner ruling D-6)
  IF approved_business_action.aap_governed_state(p_simulation) IS NULL THEN
    problems := array_append(problems, 'simulationRun must be VALUE or a governed NOT_APPLICABLE'::text);
  ELSIF p_simulation ->> 'state' = 'VALUE' AND (jsonb_typeof(p_simulation -> 'value') IS DISTINCT FROM 'string' OR NOT approved_business_action.aap_is_uuid(p_simulation ->> 'value')) THEN
    problems := array_append(problems, 'simulationRun must be a lowercase UUID'::text);
  END IF;

  RETURN problems;
END;
$$;

COMMENT ON FUNCTION approved_business_action.aap_boundary_problems(jsonb, jsonb, jsonb, jsonb, jsonb, jsonb) IS
  'Structural problems with the six governed boundary fields (empty = well formed). Mirrors the aap/1 contract and is checked against the same golden cases.';

-- ── authorized_action_boundaries ───────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS approved_business_action.authorized_action_boundaries (
  id                          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   uuid        NOT NULL REFERENCES tenancy.tenants(id)     ON DELETE RESTRICT,
  workspace_id                uuid        NOT NULL REFERENCES tenancy.workspaces(id)  ON DELETE RESTRICT,
  business_id                 uuid        NOT NULL REFERENCES platform.businesses(id) ON DELETE RESTRICT,
  action_id                   uuid        NOT NULL REFERENCES approved_business_action.approved_actions(id) ON DELETE RESTRICT,
  -- The immutable capture (0177) that fixes this action's type; the guard checks it belongs to this action.
  capture_id                  uuid        NOT NULL REFERENCES approved_business_action.authorized_action_captures(id) ON DELETE RESTRICT,
  boundary_version            integer     NOT NULL CHECK (boundary_version >= 1),
  supersedes_boundary_version integer,
  -- Governed<{ startsAt, endsAt | null }>
  execution_window            jsonb       NOT NULL,
  -- Governed<Precondition[]>
  preconditions               jsonb       NOT NULL,
  -- Governed<{ amount, currency }>
  budget                      jsonb       NOT NULL,
  -- Governed<{ instructions }>
  rollback                    jsonb       NOT NULL,
  -- Governed<{ metrics[] }>
  monitoring                  jsonb       NOT NULL,
  -- Governed<uuid>: the simulation run that backed the recommendation (soft reference; the simulation layer is not read).
  simulation_run              jsonb       NOT NULL,
  authored_by_user_id         uuid        NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  authored_at                 timestamptz NOT NULL DEFAULT clock_timestamp(),
  correlation_id              uuid        NOT NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT authorized_action_boundaries_key UNIQUE (action_id, boundary_version),
  CONSTRAINT authorized_action_boundaries_supersedes_fk
    FOREIGN KEY (action_id, supersedes_boundary_version)
    REFERENCES approved_business_action.authorized_action_boundaries (action_id, boundary_version) ON DELETE RESTRICT,
  CONSTRAINT authorized_action_boundaries_chain CHECK (
    (boundary_version = 1 AND supersedes_boundary_version IS NULL)
    OR (boundary_version > 1 AND supersedes_boundary_version IS NOT NULL AND supersedes_boundary_version = boundary_version - 1)
  ),
  CONSTRAINT authorized_action_boundaries_well_formed CHECK (
    cardinality(approved_business_action.aap_boundary_problems(execution_window, preconditions, budget, rollback, monitoring, simulation_run)) = 0
  ),
  CONSTRAINT authorized_action_boundaries_bounded CHECK (
    octet_length(preconditions::text) <= 65536 AND octet_length(monitoring::text) <= 65536 AND octet_length(rollback::text) <= 16384
    AND octet_length(execution_window::text) <= 4096 AND octet_length(budget::text) <= 4096 AND octet_length(simulation_run::text) <= 4096
  ),
  CONSTRAINT authorized_action_boundaries_ms CHECK (authored_at = date_trunc('milliseconds', authored_at))
);

COMMENT ON TABLE approved_business_action.authorized_action_boundaries IS
  'Append-only linear version chain: the execution window, preconditions, budget, rollback and monitoring of an authorized action, and its simulation reference, in the aap/1 Governed shapes. A field is NOT_APPLICABLE only where the action type (0178) says NOT_APPLICABLE_ALLOWED. Never edited: a change is a new version.';

CREATE INDEX IF NOT EXISTS authorized_action_boundaries_scope_idx
  ON approved_business_action.authorized_action_boundaries (tenant_id, workspace_id, business_id);
CREATE INDEX IF NOT EXISTS authorized_action_boundaries_action_idx
  ON approved_business_action.authorized_action_boundaries (action_id, boundary_version DESC);
CREATE INDEX IF NOT EXISTS authorized_action_boundaries_capture_idx
  ON approved_business_action.authorized_action_boundaries (capture_id);

-- ── RLS (same fail-closed predicate as 0105) and append-only (0106 function) ───────────────────────────────────────
ALTER TABLE approved_business_action.authorized_action_boundaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE approved_business_action.authorized_action_boundaries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS authorized_action_boundaries_tenant_isolation ON approved_business_action.authorized_action_boundaries;
CREATE POLICY authorized_action_boundaries_tenant_isolation ON approved_business_action.authorized_action_boundaries
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid AND workspace_id = current_setting('app.workspace_id', true)::uuid);

DROP TRIGGER IF EXISTS forbid_mutation_authorized_action_boundaries ON approved_business_action.authorized_action_boundaries;
CREATE TRIGGER forbid_mutation_authorized_action_boundaries
  BEFORE UPDATE OR DELETE ON approved_business_action.authorized_action_boundaries
  FOR EACH ROW EXECUTE FUNCTION approved_business_action.forbid_mutation();

-- ── guard: capture and ACTIVE action type, shapes, applicability, database clock ──────────────────────────────────
CREATE OR REPLACE FUNCTION approved_business_action.guard_authorized_action_boundaries_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  a RECORD;
  c RECORD;
  d RECORD;
  problems text[];
  field text;
  governed jsonb;
BEGIN
  SELECT tenant_id, workspace_id, business_id INTO a FROM approved_business_action.approved_actions WHERE id = NEW.action_id;
  IF NOT FOUND OR a.tenant_id IS DISTINCT FROM NEW.tenant_id OR a.workspace_id IS DISTINCT FROM NEW.workspace_id OR a.business_id IS DISTINCT FROM NEW.business_id THEN
    RAISE EXCEPTION 'authorized_action_boundaries: the action is not in this scope' USING ERRCODE = 'check_violation';
  END IF;

  -- The boundaries belong to the action's one immutable capture, which fixes its action type.
  SELECT id, action_type_code, action_type_schema_version INTO c
    FROM approved_business_action.authorized_action_captures WHERE action_id = NEW.action_id;
  IF NOT FOUND OR c.id IS DISTINCT FROM NEW.capture_id THEN
    RAISE EXCEPTION 'authorized_action_boundaries: the action has no capture, or the capture is not this action''s' USING ERRCODE = 'check_violation';
  END IF;

  -- The action type must be an ACTIVE governed definition (draft and retired types cannot be authorized).
  SELECT def.applicability,
         EXISTS (SELECT 1 FROM approved_business_action.action_type_status_events e WHERE e.definition_id = def.id AND e.state = 'ACTIVE')  AS is_active,
         EXISTS (SELECT 1 FROM approved_business_action.action_type_status_events e WHERE e.definition_id = def.id AND e.state = 'RETIRED') AS is_retired
    INTO d
    FROM approved_business_action.action_type_definitions def
   WHERE def.tenant_id = NEW.tenant_id AND def.workspace_id = NEW.workspace_id
     AND def.code = c.action_type_code AND def.schema_version = c.action_type_schema_version;
  IF NOT FOUND OR NOT d.is_active OR d.is_retired THEN
    RAISE EXCEPTION 'authorized_action_boundaries: no ACTIVE action type definition for %@%', c.action_type_code, c.action_type_schema_version
      USING ERRCODE = 'check_violation';
  END IF;

  problems := approved_business_action.aap_boundary_problems(NEW.execution_window, NEW.preconditions, NEW.budget, NEW.rollback, NEW.monitoring, NEW.simulation_run);
  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'authorized_action_boundaries: invalid boundaries: %', array_to_string(problems, '; ') USING ERRCODE = 'check_violation';
  END IF;

  -- A field may be NOT_APPLICABLE only where the action type explicitly allows it; anything unlisted is REQUIRED.
  FOREACH field IN ARRAY ARRAY['executionWindow', 'preconditions', 'budget', 'rollback', 'monitoring'] LOOP
    governed := CASE field
      WHEN 'executionWindow' THEN NEW.execution_window WHEN 'preconditions' THEN NEW.preconditions
      WHEN 'budget' THEN NEW.budget WHEN 'rollback' THEN NEW.rollback ELSE NEW.monitoring END;
    IF (governed ->> 'state') = 'NOT_APPLICABLE' AND (d.applicability ->> field) IS DISTINCT FROM 'NOT_APPLICABLE_ALLOWED' THEN
      RAISE EXCEPTION 'authorized_action_boundaries: %@% requires %; NOT_APPLICABLE is not permitted', c.action_type_code, c.action_type_schema_version, field
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  NEW.authored_at := date_trunc('milliseconds', clock_timestamp());
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_authorized_action_boundaries_insert ON approved_business_action.authorized_action_boundaries;
CREATE TRIGGER guard_authorized_action_boundaries_insert
  BEFORE INSERT ON approved_business_action.authorized_action_boundaries
  FOR EACH ROW EXECUTE FUNCTION approved_business_action.guard_authorized_action_boundaries_insert();

INSERT INTO _migrations (filename) VALUES ('0179_create_authorized_action_boundaries.sql')
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
