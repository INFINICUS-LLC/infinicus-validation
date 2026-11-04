-- Migration: 0225_create_billing_entitlements
-- POS2-02 (POS Core entitlement foundation) - the dedicated entitlement store.
--
-- WHAT: billing.entitlements records WHAT a tenant may use (a capability such as pos.core or intelligence.growth) and WHY (the source and a reference
-- to it), for what period. It is separate from billing.subscriptions, which stays one row per tenant and is untouched. A tenant may hold many capabilities at
-- the same time and the same capability from several sources (subscription, add-on, trial, enterprise contract, operator grant, a future provider
-- integration). The table is NOT derived from the subscription row; a derivation process will write into it later.
--
-- WHAT IS NOT HERE: no plan names, no price, no provider identifier or product name in any column or constraint (source_reference is an opaque
-- reference string owned by the source), no seed rows, no backfill, no default grant. An empty store means "not migrated to the store for this tenant": the
-- application then derives today's compatibility behaviour from the subscription state and no tenant's access changes. Final tier contents are data,
-- decided later by the owner.
--
-- TRACEABILITY / HISTORY: every row names its source_type and source_reference, its effective period and its status. Rows are never deleted and never
-- rewritten; the only permitted change is the one-way revocation (active -> revoked, with revoked_at), so "was this tenant entitled at time T" can always be
-- answered from the table (needed later to accept offline sales captured while entitled): effective_from <= T, T < effective_until (when set), T < revoked_at
-- (when set).
--
-- WRITE PATH: rows are written only through billing.grant_entitlement() and billing.revoke_entitlement() (SECURITY DEFINER, hardened search_path, no
-- dynamic SQL). The table triggers refuse any write that does not come from those functions run as their owner (marker + owner check, as for the BO
-- governed writes in 0196). grant_entitlement is idempotent: the same grant again changes nothing; the same identity with a different end is refused.
-- Both require the stated tenant to equal the transaction's authoritative app.tenant_id (what RLS keys on). EXECUTE is revoked from PUBLIC; the
-- application role is deliberately given no privilege to write (grant-app-role.sh withholds it), because no runtime code mints entitlements yet - the
-- eventual source is a governed server-side commercial process, not manual SQL.
--
-- RLS: enabled and forced, tenant-scoped on tenant_id (billing is tenant-level, see 0152). Tenant erasure retains these rows like the other append-only
-- billing history (BEFORE DELETE uses billing.forbid_mutation, which delete-tenant-data.mjs recognises). No GRANT or role statements here.

BEGIN;

CREATE TABLE billing.entitlements (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid        NOT NULL REFERENCES tenancy.tenants(id) ON DELETE RESTRICT,
  capability       text        NOT NULL,
  source_type      text        NOT NULL,
  source_reference text        NOT NULL,
  effective_from   timestamptz NOT NULL,
  effective_until  timestamptz,
  status           text        NOT NULL DEFAULT 'active',
  revoked_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entitlements_capability_shape CHECK (capability ~ '^(pos|intelligence|enterprise)\.[a-z][a-z_]*$' AND length(capability) <= 64),
  CONSTRAINT entitlements_source_type_check CHECK (source_type IN ('compatibility', 'trial', 'subscription', 'add_on', 'enterprise_contract', 'operator_grant')),
  CONSTRAINT entitlements_source_reference_check CHECK (length(btrim(source_reference)) BETWEEN 1 AND 200),
  CONSTRAINT entitlements_status_check CHECK (status IN ('active', 'revoked')),
  CONSTRAINT entitlements_period_check CHECK (effective_until IS NULL OR effective_until > effective_from),
  CONSTRAINT entitlements_revocation_check CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CONSTRAINT entitlements_identity_unique UNIQUE (tenant_id, capability, source_type, source_reference, effective_from)
);

COMMENT ON TABLE billing.entitlements IS
  'What a tenant may use, from which source and for what period (POS2-02). Many capabilities and many sources per tenant. Never deleted or rewritten; only revoked. Written only through billing.grant_entitlement / billing.revoke_entitlement.';
COMMENT ON COLUMN billing.entitlements.source_reference IS
  'Opaque reference owned by the source (an internal contract or subscription reference). Never a provider product name, price or card data; core capability semantics carry no provider identifiers.';

CREATE INDEX idx_billing_entitlements_tenant_capability ON billing.entitlements (tenant_id, capability);

-- ── governed write: grant ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION billing.grant_entitlement(
  p_tenant_id uuid, p_capability text, p_source_type text, p_source_reference text, p_effective_from timestamptz, p_effective_until timestamptz
)
RETURNS TABLE (out_entitlement_id uuid, out_created boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := nullif(pg_catalog.current_setting('app.tenant_id', true), '')::uuid;
  v_ref text := pg_catalog.btrim(p_source_reference);
  v_existing billing.entitlements%ROWTYPE;
  v_id uuid;
BEGIN
  IF p_tenant_id IS NULL OR p_capability IS NULL OR p_source_type IS NULL OR v_ref IS NULL OR p_effective_from IS NULL THEN
    RAISE EXCEPTION 'grant_entitlement: tenant, capability, source type, source reference and effective_from are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_tenant IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION 'grant_entitlement: the stated tenant is not the transaction scope' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('billing.entitlements:' || p_tenant_id::text || ':' || p_capability || ':' || p_source_type || ':' || v_ref, 0));
  SELECT * INTO v_existing FROM billing.entitlements e
   WHERE e.tenant_id = p_tenant_id AND e.capability = p_capability AND e.source_type = p_source_type AND e.source_reference = v_ref AND e.effective_from = p_effective_from;
  IF FOUND THEN
    IF v_existing.effective_until IS DISTINCT FROM p_effective_until THEN
      RAISE EXCEPTION 'grant_entitlement: this grant already exists with a different end; an entitlement is never rewritten' USING ERRCODE = 'unique_violation';
    END IF;
    RETURN QUERY SELECT v_existing.id, false;   -- an exact replay (including of a revoked grant) changes nothing
    RETURN;
  END IF;
  PERFORM pg_catalog.set_config('app.billing_entitlement_writer', 'grant_entitlement', true);
  INSERT INTO billing.entitlements (tenant_id, capability, source_type, source_reference, effective_from, effective_until)
  VALUES (p_tenant_id, p_capability, p_source_type, v_ref, p_effective_from, p_effective_until)
  RETURNING id INTO v_id;
  PERFORM pg_catalog.set_config('app.billing_entitlement_writer', '', true);
  RETURN QUERY SELECT v_id, true;
END;
$$;

-- ── governed write: revoke ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION billing.revoke_entitlement(p_tenant_id uuid, p_entitlement_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := nullif(pg_catalog.current_setting('app.tenant_id', true), '')::uuid;
  v_row billing.entitlements%ROWTYPE;
BEGIN
  IF p_tenant_id IS NULL OR p_entitlement_id IS NULL THEN
    RAISE EXCEPTION 'revoke_entitlement: tenant and entitlement are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_tenant IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION 'revoke_entitlement: the stated tenant is not the transaction scope' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_row FROM billing.entitlements e WHERE e.id = p_entitlement_id AND e.tenant_id = p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'revoke_entitlement: no such entitlement for this tenant' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_row.status = 'revoked' THEN
    RETURN false;   -- already revoked: nothing changes
  END IF;
  PERFORM pg_catalog.set_config('app.billing_entitlement_writer', 'revoke_entitlement', true);
  UPDATE billing.entitlements SET status = 'revoked', revoked_at = pg_catalog.clock_timestamp() WHERE id = p_entitlement_id;
  PERFORM pg_catalog.set_config('app.billing_entitlement_writer', '', true);
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION billing.grant_entitlement(uuid, text, text, text, timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION billing.revoke_entitlement(uuid, uuid) FROM PUBLIC;

-- ── table guards ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION billing.guard_entitlement_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_marker text := coalesce(pg_catalog.current_setting('app.billing_entitlement_writer', true), '');
  v_owner text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT pg_catalog.pg_get_userbyid(p.proowner) INTO v_owner FROM pg_catalog.pg_proc p
     WHERE p.oid = 'billing.grant_entitlement(uuid,text,text,text,timestamptz,timestamptz)'::pg_catalog.regprocedure;
    IF v_marker <> 'grant_entitlement' OR current_user IS DISTINCT FROM v_owner THEN
      RAISE EXCEPTION 'billing.entitlements: rows can only be added through grant_entitlement()' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.status <> 'active' OR NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'billing.entitlements: a new entitlement is active' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE: only the one-way revocation, through revoke_entitlement(), changing nothing else.
  SELECT pg_catalog.pg_get_userbyid(p.proowner) INTO v_owner FROM pg_catalog.pg_proc p
   WHERE p.oid = 'billing.revoke_entitlement(uuid,uuid)'::pg_catalog.regprocedure;
  IF v_marker <> 'revoke_entitlement' OR current_user IS DISTINCT FROM v_owner THEN
    RAISE EXCEPTION 'billing.entitlements: an entitlement can only be revoked through revoke_entitlement()' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status <> 'active' OR NEW.status <> 'revoked' OR NEW.revoked_at IS NULL
     OR NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.capability IS DISTINCT FROM OLD.capability
     OR NEW.source_type IS DISTINCT FROM OLD.source_type OR NEW.source_reference IS DISTINCT FROM OLD.source_reference
     OR NEW.effective_from IS DISTINCT FROM OLD.effective_from OR NEW.effective_until IS DISTINCT FROM OLD.effective_until
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'billing.entitlements: only an active entitlement may be revoked, and nothing else may change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_entitlements_write BEFORE INSERT OR UPDATE ON billing.entitlements
  FOR EACH ROW EXECUTE FUNCTION billing.guard_entitlement_write();
-- Never deleted or truncated (billing.forbid_mutation is the form tenant erasure recognises as retained history).
CREATE TRIGGER forbid_delete_entitlements BEFORE DELETE ON billing.entitlements
  FOR EACH ROW EXECUTE FUNCTION billing.forbid_mutation();
CREATE TRIGGER forbid_truncate_entitlements BEFORE TRUNCATE ON billing.entitlements
  FOR EACH STATEMENT EXECUTE FUNCTION billing.forbid_mutation();

-- ── tenant isolation ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE billing.entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.entitlements FORCE ROW LEVEL SECURITY;
CREATE POLICY entitlements_isolation ON billing.entitlements
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

INSERT INTO _migrations (filename) VALUES ('0225_create_billing_entitlements.sql') ON CONFLICT (filename) DO NOTHING;

COMMIT;
