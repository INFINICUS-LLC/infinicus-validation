-- Migration: 0185_create_business_currency_declarations
-- Business Administration (owner-authorised): the governed, business-scoped DECLARED CURRENCY.
--
-- OWNERSHIP: Business Administration owns "Currency" (locked manifest). This table lives in the `platform` schema beside
-- platform.businesses. Business Operations and Approved Business Action may READ the current declaration through a governed read
-- boundary; neither writes it, and the Data Acquisition layer never does.
--
-- WHAT IT IS: one row = one explicit declaration (or an explicit change) of the currency a business operates in for governance and cost
-- evaluation. The rows form a linear, append-only version chain per business. A business with NO row is UNDECLARED - the absence of a
-- row is the only representation of "not declared", so a silent default can never become governed evidence.
--
-- WHAT IT IS NOT: it is not derived from, copied from or reconciled with tenancy.tenants.default_currency or
-- business_operations.business_profile_extensions.default_currency (both are silent DEFAULT 'USD' columns and are left exactly as they
-- are). No row is inserted by this migration: no backfill, no default promotion. Changing a declaration never rewrites an inventory cost
-- currency, an evaluation row or any other historical fact.
--
-- DATABASE-ENFORCED (not only in the service): canonical three-uppercase-letter code; linear versions (first declaration is version 1,
-- every later one is exactly previous + 1 and records the prior currency); a change must change the currency and carry a reason;
-- declared_at is stamped by the database clock; the business must belong to the same tenant and workspace; RLS forced on tenant +
-- workspace; UPDATE, DELETE and TRUNCATE rejected for every role (platform.forbid_mutation, the repository convention that
-- delete-tenant-data.mjs uses to discover append-only tables).
--
-- Idempotent. No GRANT or role statements (role provisioning is environment-specific, see grant-app-role.sh).

BEGIN;

CREATE TABLE IF NOT EXISTS platform.business_currency_declarations (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid        NOT NULL REFERENCES tenancy.tenants(id)    ON DELETE RESTRICT,
  workspace_id            uuid        NOT NULL REFERENCES tenancy.workspaces(id) ON DELETE RESTRICT,
  business_id             uuid        NOT NULL REFERENCES platform.businesses(id) ON DELETE RESTRICT,
  version                 integer     NOT NULL,
  declared_currency       text        NOT NULL,
  -- The declaration this one replaced; both NULL for the first declaration (version 1).
  supersedes_version      integer,
  prior_declared_currency text,
  provenance              text        NOT NULL,
  -- Soft reference (no FK): a referential action must never be able to rewrite this append-only record.
  declared_by_user_id     uuid        NOT NULL,
  permission_used         text        NOT NULL,
  reason                  text,
  correlation_id          uuid        NOT NULL,
  declared_at             timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT business_currency_declarations_version_unique UNIQUE (business_id, version),
  CONSTRAINT business_currency_declarations_version_positive CHECK (version >= 1),
  CONSTRAINT business_currency_declarations_currency_format CHECK (declared_currency ~ '^[A-Z]{3}$'),
  CONSTRAINT business_currency_declarations_prior_format CHECK (prior_declared_currency IS NULL OR prior_declared_currency ~ '^[A-Z]{3}$'),
  -- COALESCE: a CHECK that evaluates to NULL passes, so every branch is forced to a definite boolean.
  CONSTRAINT business_currency_declarations_chain_shape CHECK (COALESCE(
    (version = 1 AND supersedes_version IS NULL AND prior_declared_currency IS NULL)
    OR (version > 1 AND supersedes_version = version - 1 AND prior_declared_currency IS NOT NULL AND prior_declared_currency <> declared_currency),
    false)
  ),
  CONSTRAINT business_currency_declarations_provenance CHECK (provenance IN ('EXPLICIT_DECLARATION')),
  CONSTRAINT business_currency_declarations_permission CHECK (length(btrim(permission_used)) > 0 AND length(permission_used) <= 100),
  -- A change (version > 1) must carry a non-blank reason; a first declaration may omit it.
  CONSTRAINT business_currency_declarations_reason CHECK (COALESCE(
    (reason IS NULL OR (length(btrim(reason)) > 0 AND length(reason) <= 1000))
    AND (version = 1 OR (reason IS NOT NULL AND length(btrim(reason)) > 0)),
    false)
  ),
  CONSTRAINT business_currency_declarations_declared_ms CHECK (declared_at = date_trunc('milliseconds', declared_at))
);

COMMENT ON TABLE platform.business_currency_declarations IS
  'Append-only. Business Administration-owned, business-scoped DECLARED CURRENCY: one row per explicit declaration or change, a linear version chain per business. No row = UNDECLARED. Never derived from any silent-default column; never rewrites historical cost or evaluation evidence.';
COMMENT ON COLUMN platform.business_currency_declarations.declared_currency IS
  'Canonical three-uppercase-letter code, chosen explicitly by an authorised actor. Not inferred from any default.';

CREATE INDEX IF NOT EXISTS business_currency_declarations_scope_idx
  ON platform.business_currency_declarations (tenant_id, workspace_id, business_id, version DESC);

-- ── insert guard: database clock, scope, and the linear chain ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION platform.guard_business_currency_declaration_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  biz RECORD;
  latest RECORD;
BEGIN
  NEW.declared_at := date_trunc('milliseconds', clock_timestamp());

  SELECT tenant_id, workspace_id INTO biz FROM platform.businesses WHERE id = NEW.business_id;
  IF NOT FOUND OR biz.tenant_id IS DISTINCT FROM NEW.tenant_id OR biz.workspace_id IS DISTINCT FROM NEW.workspace_id THEN
    RAISE EXCEPTION 'business_currency_declarations: the business is not in this tenant and workspace'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT version, declared_currency INTO latest
    FROM platform.business_currency_declarations WHERE business_id = NEW.business_id ORDER BY version DESC LIMIT 1;
  IF NOT FOUND THEN
    IF NEW.version IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION 'business_currency_declarations: the first declaration must be version 1' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW.version IS DISTINCT FROM latest.version + 1
       OR NEW.supersedes_version IS DISTINCT FROM latest.version
       OR NEW.prior_declared_currency IS DISTINCT FROM latest.declared_currency THEN
      RAISE EXCEPTION 'business_currency_declarations: a declaration must supersede the current version and record its currency'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_business_currency_declaration_insert ON platform.business_currency_declarations;
CREATE TRIGGER guard_business_currency_declaration_insert
  BEFORE INSERT ON platform.business_currency_declarations
  FOR EACH ROW EXECUTE FUNCTION platform.guard_business_currency_declaration_insert();

-- ── append-only: UPDATE, DELETE and TRUNCATE are rejected for every role ────────────────────────────────────────────────────
-- Named `forbid_mutation` like every other schema's guard, which is how delete-tenant-data.mjs discovers append-only tables.
CREATE OR REPLACE FUNCTION platform.forbid_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'platform.%: append-only table - % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

DROP TRIGGER IF EXISTS forbid_mutation_business_currency_declarations ON platform.business_currency_declarations;
CREATE TRIGGER forbid_mutation_business_currency_declarations
  BEFORE UPDATE OR DELETE ON platform.business_currency_declarations
  FOR EACH ROW EXECUTE FUNCTION platform.forbid_mutation();

DROP TRIGGER IF EXISTS forbid_truncate_business_currency_declarations ON platform.business_currency_declarations;
CREATE TRIGGER forbid_truncate_business_currency_declarations
  BEFORE TRUNCATE ON platform.business_currency_declarations
  FOR EACH STATEMENT EXECUTE FUNCTION platform.forbid_mutation();

-- ── row-level security: tenant + workspace, forced ──────────────────────────────────────────────────────────────────────────
ALTER TABLE platform.business_currency_declarations ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.business_currency_declarations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS business_currency_declarations_isolation ON platform.business_currency_declarations;
CREATE POLICY business_currency_declarations_isolation ON platform.business_currency_declarations
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid AND workspace_id = current_setting('app.workspace_id', true)::uuid);

INSERT INTO _migrations (filename) VALUES ('0185_create_business_currency_declarations.sql')
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
