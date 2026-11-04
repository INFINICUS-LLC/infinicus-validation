-- STRIPE-SBX-01: provider identity and durable webhook replay protection for the billing schema. DEVELOPMENT CANDIDATE: nothing here activates a provider.
-- Forward-only and additive: three new tables, one new unique key on an existing table, and narrow functions. No existing row, column, trigger or policy changes.
--
--  * billing.provider_customers          one row per (provider, provider customer id) -> tenant. The trust anchor. Written ONLY by a trusted INFINICUS server flow
--                                        under the authenticated tenant's context (RLS WITH CHECK pins tenant_id). Never derived from email, name or webhook metadata.
--  * billing.provider_subscription_links one row per (provider, provider subscription id), pinned by composite keys to the SAME tenant AND the SAME provider as its
--                                        customer. A tenant may hold MANY provider subscriptions (POS Core, intelligence, add-ons, enterprise): there is deliberately
--                                        no tenant-level uniqueness here. internal_subscription_id is optional (billing.subscriptions is still one row per tenant;
--                                        POS2-02 owns the multi-product subscription architecture) and, when set, is pinned to the same tenant.
--  * billing.provider_events             the durable event ledger: unique (provider, event id), immutable identity (type + payload hash), claim state machine
--                                        claimed -> processed | failed, failed -> claimed (retry), attempt count, fixed result codes only (never payload or detail).
--                                        Written only through the governed functions below (marker + function-owner check, as migration 0196).
--
-- The three SECURITY DEFINER functions that act before a tenant is known (claim / resolve / check) pin search_path, schema-qualify every relation, return only the
-- identifiers they need, and are not executable by PUBLIC. Role provisioning (EXECUTE for the application role) is done by grant-app-role.sh, as for every function.
-- Rollback (development only, never after rows exist in a shared environment): DROP the functions, then the three tables, then billing.subscriptions_id_tenant_key.
BEGIN;

-- Composite parent key so a link's internal subscription is pinned to the link's tenant (additive; id is already unique, this only adds the tenant to the key).
ALTER TABLE billing.subscriptions ADD CONSTRAINT subscriptions_id_tenant_key UNIQUE (id, tenant_id);

-- ── billing.provider_customers ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE billing.provider_customers (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider             text        NOT NULL CONSTRAINT provider_customers_provider_check CHECK (provider ~ '^[a-z][a-z0-9_]{1,31}$'),
  provider_customer_id text        NOT NULL CONSTRAINT provider_customers_customer_id_check CHECK (provider_customer_id ~ '^[A-Za-z0-9_-]{1,255}$'),
  tenant_id            uuid        NOT NULL REFERENCES tenancy.tenants(id) ON DELETE RESTRICT,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_customers_identity_key UNIQUE (provider, provider_customer_id),
  CONSTRAINT provider_customers_pin_key UNIQUE (id, tenant_id, provider)
);
COMMENT ON TABLE billing.provider_customers IS 'Trusted provider customer -> tenant linkage. Append-only. Created only by a trusted server-side flow; never from an email, a name, webhook metadata or a client-supplied tenant id.';

-- ── billing.provider_subscription_links ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE billing.provider_subscription_links (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider                  text        NOT NULL,
  provider_subscription_id  text        NOT NULL CONSTRAINT provider_subscription_links_subscription_id_check CHECK (provider_subscription_id ~ '^[A-Za-z0-9_-]{1,255}$'),
  provider_customer_ref     uuid        NOT NULL,
  tenant_id                 uuid        NOT NULL,
  internal_subscription_id  uuid,
  created_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_subscription_links_identity_key UNIQUE (provider, provider_subscription_id),
  CONSTRAINT provider_subscription_links_customer_fk FOREIGN KEY (provider_customer_ref, tenant_id, provider)
    REFERENCES billing.provider_customers (id, tenant_id, provider) ON DELETE RESTRICT,
  CONSTRAINT provider_subscription_links_internal_fk FOREIGN KEY (internal_subscription_id, tenant_id)
    REFERENCES billing.subscriptions (id, tenant_id) ON DELETE RESTRICT
);
CREATE INDEX provider_subscription_links_tenant_idx ON billing.provider_subscription_links (tenant_id);
CREATE INDEX provider_subscription_links_customer_idx ON billing.provider_subscription_links (provider_customer_ref);
COMMENT ON TABLE billing.provider_subscription_links IS 'Provider subscription identity, pinned to its customer, tenant and provider. Many per tenant are allowed. Append-only.';

-- ── billing.provider_events ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE billing.provider_events (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider         text        NOT NULL CONSTRAINT provider_events_provider_check CHECK (provider ~ '^[a-z][a-z0-9_]{1,31}$'),
  event_id         text        NOT NULL CONSTRAINT provider_events_event_id_check CHECK (event_id ~ '^[A-Za-z0-9_-]{1,255}$'),
  event_type       text        NOT NULL CONSTRAINT provider_events_event_type_check CHECK (event_type ~ '^[a-z][a-z0-9_.]{0,127}$'),
  payload_hash     char(64)    NOT NULL CONSTRAINT provider_events_payload_hash_check CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  tenant_id        uuid        REFERENCES tenancy.tenants(id) ON DELETE RESTRICT,
  state            text        NOT NULL DEFAULT 'claimed' CONSTRAINT provider_events_state_check CHECK (state IN ('claimed', 'processed', 'failed')),
  attempt_count    integer     NOT NULL DEFAULT 1 CONSTRAINT provider_events_attempt_check CHECK (attempt_count BETWEEN 1 AND 1000),
  result_code      text        CONSTRAINT provider_events_result_code_check CHECK (result_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  received_at      timestamptz NOT NULL DEFAULT now(),
  last_attempt_at  timestamptz NOT NULL DEFAULT now(),
  processed_at     timestamptz,
  CONSTRAINT provider_events_identity_key UNIQUE (provider, event_id),
  CONSTRAINT provider_events_processed_at_check CHECK ((state = 'processed') = (processed_at IS NOT NULL)),
  CONSTRAINT provider_events_result_state_check CHECK (state = 'claimed' OR result_code IS NOT NULL)
);
CREATE INDEX provider_events_tenant_idx ON billing.provider_events (tenant_id) WHERE tenant_id IS NOT NULL;
COMMENT ON TABLE billing.provider_events IS 'Durable provider webhook ledger: unique (provider, event id), immutable identity, claim state machine, fixed result codes. No payload, no payment detail, no secret is stored.';

-- ── RLS (tenant scope; rows whose tenant is not yet resolved are visible to no tenant session) ──────────────────────────────────────────────────────────
ALTER TABLE billing.provider_customers          ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.provider_customers          FORCE  ROW LEVEL SECURITY;
CREATE POLICY provider_customers_isolation ON billing.provider_customers
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
ALTER TABLE billing.provider_subscription_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.provider_subscription_links FORCE  ROW LEVEL SECURITY;
CREATE POLICY provider_subscription_links_isolation ON billing.provider_subscription_links
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
ALTER TABLE billing.provider_events             ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.provider_events             FORCE  ROW LEVEL SECURITY;
CREATE POLICY provider_events_isolation ON billing.provider_events
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ── append-only identity tables (reuses billing.forbid_mutation from migration 0153) ────────────────────────────────────────────────────────────────────
CREATE TRIGGER forbid_mutation_provider_customers BEFORE UPDATE OR DELETE ON billing.provider_customers FOR EACH ROW EXECUTE FUNCTION billing.forbid_mutation();
CREATE TRIGGER forbid_truncate_provider_customers BEFORE TRUNCATE ON billing.provider_customers FOR EACH STATEMENT EXECUTE FUNCTION billing.forbid_mutation();
CREATE TRIGGER forbid_mutation_provider_subscription_links BEFORE UPDATE OR DELETE ON billing.provider_subscription_links FOR EACH ROW EXECUTE FUNCTION billing.forbid_mutation();
CREATE TRIGGER forbid_truncate_provider_subscription_links BEFORE TRUNCATE ON billing.provider_subscription_links FOR EACH STATEMENT EXECUTE FUNCTION billing.forbid_mutation();

-- ── provider_events guard: governed writer only; identity is immutable; the state machine is closed ────────────────────────────────────────────────────
-- A write is allowed only inside billing.claim_provider_event / complete_provider_event / fail_provider_event: their transaction-local marker AND current_user being the
-- OWNER of the claim function (a session variable alone is not sufficient: a caller cannot become the function owner). Rows are never deleted or truncated.
CREATE OR REPLACE FUNCTION billing.guard_provider_events() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'billing.provider_events: append-only ledger - % is not permitted', TG_OP USING ERRCODE = 'raise_exception';
  END IF;
  IF current_setting('billing.provider_event_writer', true) IS DISTINCT FROM 'on'
     OR current_user IS DISTINCT FROM (SELECT pg_catalog.pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc p
                                         WHERE p.oid = 'billing.claim_provider_event(text,text,text,text)'::pg_catalog.regprocedure) THEN
    RAISE EXCEPTION 'billing.provider_events: written only by the governed billing functions' USING ERRCODE = 'raise_exception';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id <> OLD.id OR NEW.provider <> OLD.provider OR NEW.event_id <> OLD.event_id OR NEW.event_type <> OLD.event_type
       OR NEW.payload_hash <> OLD.payload_hash OR NEW.received_at <> OLD.received_at THEN
      RAISE EXCEPTION 'billing.provider_events: event identity is immutable' USING ERRCODE = 'raise_exception';
    END IF;
    IF OLD.state = 'processed' THEN
      RAISE EXCEPTION 'billing.provider_events: a processed event is final' USING ERRCODE = 'raise_exception';
    END IF;
    IF OLD.tenant_id IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
      RAISE EXCEPTION 'billing.provider_events: tenant is immutable once resolved' USING ERRCODE = 'raise_exception';
    END IF;
    IF NOT ((OLD.state = 'claimed' AND NEW.state IN ('claimed', 'processed', 'failed')) OR (OLD.state = 'failed' AND NEW.state = 'claimed')) THEN
      RAISE EXCEPTION 'billing.provider_events: illegal state transition' USING ERRCODE = 'raise_exception';
    END IF;
  ELSIF NEW.state <> 'claimed' OR NEW.attempt_count <> 1 THEN
    RAISE EXCEPTION 'billing.provider_events: an event is created claimed with attempt 1' USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_provider_events BEFORE INSERT OR UPDATE OR DELETE ON billing.provider_events FOR EACH ROW EXECUTE FUNCTION billing.guard_provider_events();
CREATE TRIGGER forbid_truncate_provider_events BEFORE TRUNCATE ON billing.provider_events FOR EACH STATEMENT EXECUTE FUNCTION billing.guard_provider_events();

-- ── governed functions (SECURITY DEFINER; search_path pinned; no payload, no secret, no detail in or out) ───────────────────────────────────────────────

-- Atomic claim. CLAIMED = this caller owns the processing attempt; DUPLICATE = already processed (replay, apply nothing); IN_PROGRESS = another attempt holds a fresh claim;
-- CONFLICT = the same (provider, event id) arrived with a different type or payload hash (identity collision / forgery). A failed event, or a claim older than five minutes
-- (a crashed attempt), is re-claimed with the attempt count incremented.
CREATE OR REPLACE FUNCTION billing.claim_provider_event(p_provider text, p_event_id text, p_event_type text, p_payload_hash text)
RETURNS TABLE (outcome text, attempt_count integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE r billing.provider_events%ROWTYPE; v_id uuid;
BEGIN
  PERFORM pg_catalog.set_config('billing.provider_event_writer', 'on', true);
  INSERT INTO billing.provider_events (provider, event_id, event_type, payload_hash)
  VALUES (p_provider, p_event_id, p_event_type, p_payload_hash)
  ON CONFLICT (provider, event_id) DO NOTHING RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN RETURN QUERY SELECT 'CLAIMED'::text, 1; RETURN; END IF;
  SELECT * INTO r FROM billing.provider_events e WHERE e.provider = p_provider AND e.event_id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'IN_PROGRESS'::text, 0; RETURN; END IF;
  IF r.payload_hash <> p_payload_hash OR r.event_type <> p_event_type THEN RETURN QUERY SELECT 'CONFLICT'::text, r.attempt_count; RETURN; END IF;
  IF r.state = 'processed' THEN RETURN QUERY SELECT 'DUPLICATE'::text, r.attempt_count; RETURN; END IF;
  IF r.state = 'failed' OR (r.state = 'claimed' AND r.last_attempt_at < pg_catalog.now() - interval '5 minutes') THEN
    UPDATE billing.provider_events e SET state = 'claimed', attempt_count = e.attempt_count + 1, last_attempt_at = pg_catalog.now(), result_code = NULL
     WHERE e.id = r.id RETURNING e.attempt_count INTO r.attempt_count;
    RETURN QUERY SELECT 'CLAIMED'::text, r.attempt_count; RETURN;
  END IF;
  RETURN QUERY SELECT 'IN_PROGRESS'::text, r.attempt_count;
END;
$$;

-- Closes a claimed attempt. Returns false when the event is not currently claimed (nothing changes).
CREATE OR REPLACE FUNCTION billing.finish_provider_event(p_provider text, p_event_id text, p_state text, p_result_code text, p_tenant_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_state NOT IN ('processed', 'failed') THEN RAISE EXCEPTION 'billing.finish_provider_event: invalid state' USING ERRCODE = '22023'; END IF;
  PERFORM pg_catalog.set_config('billing.provider_event_writer', 'on', true);
  UPDATE billing.provider_events e
     SET state = p_state, result_code = p_result_code, tenant_id = COALESCE(p_tenant_id, e.tenant_id),
         processed_at = CASE WHEN p_state = 'processed' THEN pg_catalog.now() ELSE NULL END
   WHERE e.provider = p_provider AND e.event_id = p_event_id AND e.state = 'claimed';
  RETURN FOUND;
END;
$$;

-- Resolves a trusted provider customer to its tenant (and the tenant's billing workspace). No row = unknown customer (or a tenant without a subscription row): the caller refuses.
CREATE OR REPLACE FUNCTION billing.resolve_provider_customer(p_provider text, p_provider_customer_id text)
RETURNS TABLE (tenant_id uuid, workspace_id uuid)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT c.tenant_id, s.workspace_id
    FROM billing.provider_customers c JOIN billing.subscriptions s ON s.tenant_id = c.tenant_id
   WHERE c.provider = p_provider AND c.provider_customer_id = p_provider_customer_id;
$$;

-- Compares a provider subscription with a provider customer: UNLINKED (no link), MATCH (linked to this customer) or MISMATCH (linked to a different customer). Returns nothing else.
CREATE OR REPLACE FUNCTION billing.check_provider_subscription_link(p_provider text, p_provider_subscription_id text, p_provider_customer_id text)
RETURNS text LANGUAGE sql SECURITY DEFINER STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT COALESCE((SELECT CASE WHEN c.provider_customer_id = p_provider_customer_id THEN 'MATCH' ELSE 'MISMATCH' END
                     FROM billing.provider_subscription_links l JOIN billing.provider_customers c ON c.id = l.provider_customer_ref
                    WHERE l.provider = p_provider AND l.provider_subscription_id = p_provider_subscription_id), 'UNLINKED');
$$;

-- Establishes the provider subscription identity from an already TRUSTED customer link (the tenant comes from the customer row, never from the caller). LINKED, ALREADY_LINKED
-- (same customer), MISMATCH (linked to a different customer) or CUSTOMER_UNKNOWN. Never creates a customer and never touches billing.subscriptions.
CREATE OR REPLACE FUNCTION billing.link_provider_subscription(p_provider text, p_provider_subscription_id text, p_provider_customer_id text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE c billing.provider_customers%ROWTYPE; v_id uuid; v_existing text;
BEGIN
  SELECT * INTO c FROM billing.provider_customers pc WHERE pc.provider = p_provider AND pc.provider_customer_id = p_provider_customer_id;
  IF NOT FOUND THEN RETURN 'CUSTOMER_UNKNOWN'; END IF;
  INSERT INTO billing.provider_subscription_links (provider, provider_subscription_id, provider_customer_ref, tenant_id)
  VALUES (p_provider, p_provider_subscription_id, c.id, c.tenant_id)
  ON CONFLICT (provider, provider_subscription_id) DO NOTHING RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN RETURN 'LINKED'; END IF;
  v_existing := billing.check_provider_subscription_link(p_provider, p_provider_subscription_id, p_provider_customer_id);
  RETURN CASE v_existing WHEN 'MATCH' THEN 'ALREADY_LINKED' ELSE 'MISMATCH' END;
END;
$$;

-- No PUBLIC execution. The application role receives EXECUTE through infrastructure/database/scripts/grant-app-role.sh (as for every function).
REVOKE ALL ON FUNCTION billing.guard_provider_events()                                      FROM PUBLIC;
REVOKE ALL ON FUNCTION billing.claim_provider_event(text, text, text, text)                 FROM PUBLIC;
REVOKE ALL ON FUNCTION billing.finish_provider_event(text, text, text, text, uuid)          FROM PUBLIC;
REVOKE ALL ON FUNCTION billing.resolve_provider_customer(text, text)                        FROM PUBLIC;
REVOKE ALL ON FUNCTION billing.check_provider_subscription_link(text, text, text)           FROM PUBLIC;
REVOKE ALL ON FUNCTION billing.link_provider_subscription(text, text, text)                 FROM PUBLIC;

INSERT INTO _migrations (filename) VALUES ('0225_billing_provider_links_and_events.sql') ON CONFLICT (filename) DO NOTHING;

COMMIT;
