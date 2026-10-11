-- Migration: 0182_create_bo_inventory_policy_evaluations
-- P0-5/P0-6 preparation, Block B2a (owner-authorised): the BO-owned, immutable record of governance evaluations.
--
-- BO-OWNED persistence only (schema business_operations). One row is ONE authoritative evaluation, for ONE governance dimension
-- (CONSTRAINTS, RESOURCE_REQUIREMENTS, COST, EXPECTED_OUTCOME), of ONE exact proposed action subject:
--   { actionType: { code, schemaVersion }, target: { kind, id }, finalParameters }
-- bound by `subject_digest` (sha256 over the canonical subject, computed with the shared contract helper) and stored verbatim in
-- `subject` so the binding can be re-derived and audited. Evidence produced for one parameter set can never verify another.
--
-- THIS MIGRATION STORES RESULTS; IT EVALUATES NOTHING. There are no rules, thresholds, capacity conversions, freshness windows or
-- defaults here: the evaluator (a later, separately authorised block) produces the result, the rule-set version it used, the BO facts it
-- read (`inputs`) and the per-rule `findings`. FAILED and INDETERMINATE are stored distinctly and, by contract, never qualify as
-- verified PASSED evidence. ABA may later VERIFY a row through an adapter; ABA is never the source of truth and nothing here reads or
-- writes ABA storage (no foreign key into approved_business_action; requested_by_user_id is a soft reference so that the append-only
-- guarantee can never be undermined by a referential action).
--
-- Append-only (UPDATE, DELETE, TRUNCATE rejected for every role), RLS forced on tenant + workspace, evaluated_at stamped by the
-- database clock. No inventory table is mutated, no event is emitted, nothing is seeded.

BEGIN;

CREATE TABLE IF NOT EXISTS business_operations.inventory_policy_evaluations (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid        NOT NULL REFERENCES tenancy.tenants(id)          ON DELETE RESTRICT,
  workspace_id          uuid        NOT NULL REFERENCES tenancy.workspaces(id)       ON DELETE RESTRICT,
  business_id           uuid        NOT NULL REFERENCES platform.businesses(id)      ON DELETE RESTRICT,
  inventory_item_id     uuid        NOT NULL REFERENCES platform.inventory_items(id) ON DELETE RESTRICT,
  -- NULL = the evaluation is about the item as a whole; set when the evaluated truth is warehouse-specific.
  warehouse_id          uuid                 REFERENCES platform.warehouses(id)      ON DELETE RESTRICT,
  dimension             text        NOT NULL,
  result                text        NOT NULL,
  subject               jsonb       NOT NULL,
  subject_digest        text        NOT NULL,
  rule_set_version      text        NOT NULL,
  inputs                jsonb       NOT NULL,
  findings              jsonb       NOT NULL,
  evaluated_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  requested_by_user_id  uuid        NOT NULL,
  correlation_id        uuid        NOT NULL,

  CONSTRAINT inventory_policy_evaluations_dimension CHECK (dimension IN ('CONSTRAINTS', 'RESOURCE_REQUIREMENTS', 'COST', 'EXPECTED_OUTCOME')),
  CONSTRAINT inventory_policy_evaluations_result CHECK (result IN ('PASSED', 'FAILED', 'INDETERMINATE')),
  CONSTRAINT inventory_policy_evaluations_digest CHECK (subject_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT inventory_policy_evaluations_rule_set CHECK (length(btrim(rule_set_version)) > 0 AND length(rule_set_version) <= 200),
  CONSTRAINT inventory_policy_evaluations_evaluated_ms CHECK (evaluated_at = date_trunc('milliseconds', evaluated_at)),
  -- Shape only: the subject is the canonical { actionType, target, finalParameters } object. No rule logic lives here.
  -- COALESCE: a missing member yields NULL, and a CHECK that evaluates to NULL passes - a missing member must FAIL.
  CONSTRAINT inventory_policy_evaluations_subject_shape CHECK (COALESCE(
    jsonb_typeof(subject) = 'object'
    AND jsonb_typeof(subject -> 'actionType') = 'object'
    AND jsonb_typeof(subject #> '{actionType,code}') = 'string' AND length(btrim(subject #>> '{actionType,code}')) > 0
    AND jsonb_typeof(subject #> '{actionType,schemaVersion}') = 'string' AND length(btrim(subject #>> '{actionType,schemaVersion}')) > 0
    AND jsonb_typeof(subject -> 'target') = 'object'
    AND jsonb_typeof(subject #> '{target,kind}') = 'string' AND length(btrim(subject #>> '{target,kind}')) > 0
    AND jsonb_typeof(subject #> '{target,id}') = 'string' AND length(btrim(subject #>> '{target,id}')) > 0
    AND jsonb_typeof(subject -> 'finalParameters') = 'object',
    false)
  ),
  CONSTRAINT inventory_policy_evaluations_inputs_shape CHECK (jsonb_typeof(inputs) = 'object'),
  CONSTRAINT inventory_policy_evaluations_findings_shape CHECK (jsonb_typeof(findings) = 'array'),
  CONSTRAINT inventory_policy_evaluations_bounded CHECK (
    octet_length(subject::text) <= 65536 AND octet_length(inputs::text) <= 262144 AND octet_length(findings::text) <= 262144
  )
);

COMMENT ON TABLE business_operations.inventory_policy_evaluations IS
  'Append-only. BO-owned record of ONE governance evaluation (one dimension) of ONE exact action subject, bound by subject_digest. Stores the evaluator''s result; evaluates nothing. FAILED and INDETERMINATE never qualify as verified PASSED evidence. ABA may verify a row; ABA is never the source of truth.';
COMMENT ON COLUMN business_operations.inventory_policy_evaluations.subject_digest IS
  'sha256:<hex> over the canonical subject { actionType, target, finalParameters } (shared contract helper). Binds the evidence to exact values.';
COMMENT ON COLUMN business_operations.inventory_policy_evaluations.rule_set_version IS
  'The owner-approved, versioned rule set the evaluator applied. Opaque here: B2a does not interpret it.';

CREATE INDEX IF NOT EXISTS inventory_policy_evaluations_business_idx
  ON business_operations.inventory_policy_evaluations (tenant_id, workspace_id, business_id, evaluated_at DESC);
CREATE INDEX IF NOT EXISTS inventory_policy_evaluations_subject_idx
  ON business_operations.inventory_policy_evaluations (tenant_id, workspace_id, business_id, subject_digest, dimension);
CREATE INDEX IF NOT EXISTS inventory_policy_evaluations_item_idx
  ON business_operations.inventory_policy_evaluations (inventory_item_id);

-- ── insert guard: the database clock stamps the fact; the target must belong to the same tenant, workspace and business ─────────
CREATE OR REPLACE FUNCTION business_operations.guard_inventory_policy_evaluation_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  item RECORD;
  wh RECORD;
BEGIN
  NEW.evaluated_at := date_trunc('milliseconds', clock_timestamp());

  SELECT tenant_id, workspace_id, business_id INTO item FROM platform.inventory_items WHERE id = NEW.inventory_item_id;
  IF NOT FOUND OR item.tenant_id IS DISTINCT FROM NEW.tenant_id OR item.workspace_id IS DISTINCT FROM NEW.workspace_id
     OR item.business_id IS DISTINCT FROM NEW.business_id THEN
    RAISE EXCEPTION 'inventory_policy_evaluations: the inventory item is not in this tenant, workspace and business'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.warehouse_id IS NOT NULL THEN
    SELECT tenant_id, workspace_id, business_id INTO wh FROM platform.warehouses WHERE id = NEW.warehouse_id;
    IF NOT FOUND OR wh.tenant_id IS DISTINCT FROM NEW.tenant_id OR wh.workspace_id IS DISTINCT FROM NEW.workspace_id
       OR wh.business_id IS DISTINCT FROM NEW.business_id THEN
      RAISE EXCEPTION 'inventory_policy_evaluations: the warehouse is not in this tenant, workspace and business'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_inventory_policy_evaluation_insert ON business_operations.inventory_policy_evaluations;
CREATE TRIGGER guard_inventory_policy_evaluation_insert
  BEFORE INSERT ON business_operations.inventory_policy_evaluations
  FOR EACH ROW EXECUTE FUNCTION business_operations.guard_inventory_policy_evaluation_insert();

-- ── append-only: UPDATE, DELETE and TRUNCATE are rejected for every role ────────────────────────────────────────────────
-- Named `forbid_mutation` like every other layer's guard, which is how delete-tenant-data.mjs discovers append-only tables.
CREATE OR REPLACE FUNCTION business_operations.forbid_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'business_operations.%: append-only table - % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

DROP TRIGGER IF EXISTS forbid_mutation_inventory_policy_evaluations ON business_operations.inventory_policy_evaluations;
CREATE TRIGGER forbid_mutation_inventory_policy_evaluations
  BEFORE UPDATE OR DELETE ON business_operations.inventory_policy_evaluations
  FOR EACH ROW EXECUTE FUNCTION business_operations.forbid_mutation();

DROP TRIGGER IF EXISTS forbid_truncate_inventory_policy_evaluations ON business_operations.inventory_policy_evaluations;
CREATE TRIGGER forbid_truncate_inventory_policy_evaluations
  BEFORE TRUNCATE ON business_operations.inventory_policy_evaluations
  FOR EACH STATEMENT EXECUTE FUNCTION business_operations.forbid_mutation();

-- ── row-level security: tenant + workspace, forced (the same hardened pattern as 0180) ──────────────────────────────────
ALTER TABLE business_operations.inventory_policy_evaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_operations.inventory_policy_evaluations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inventory_policy_evaluations_isolation ON business_operations.inventory_policy_evaluations;
CREATE POLICY inventory_policy_evaluations_isolation ON business_operations.inventory_policy_evaluations
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid AND workspace_id = current_setting('app.workspace_id', true)::uuid);

INSERT INTO _migrations (filename) VALUES ('0182_create_bo_inventory_policy_evaluations.sql')
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
