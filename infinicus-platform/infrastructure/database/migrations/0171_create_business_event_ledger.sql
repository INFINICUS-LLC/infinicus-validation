-- Migration: 0171_create_business_event_ledger
-- BUILD-33 — canonical immutable cross-domain Business Event Ledger.
-- Additive only: preserves events.outbox_events and all legacy event stores.
-- DATA → Event Ledger owns canonical recording/lineage; domain state remains
-- authoritative in the producing domain.

BEGIN;

CREATE TABLE events.business_event_ledger (
  event_id          uuid        PRIMARY KEY,
  event_type        text        NOT NULL,
  event_version     text        NOT NULL,

  tenant_id         uuid        NOT NULL REFERENCES tenancy.tenants(id) ON DELETE RESTRICT,
  workspace_id      uuid        NOT NULL REFERENCES tenancy.workspaces(id) ON DELETE RESTRICT,
  business_id       uuid        REFERENCES platform.businesses(id) ON DELETE RESTRICT,

  source_domain     text        NOT NULL,
  source_service    text        NOT NULL,

  aggregate_type    text        NOT NULL,
  aggregate_id      text        NOT NULL,

  correlation_id    uuid        NOT NULL,
  causation_id      uuid,

  actor_type        text,
  actor_id          text,

  idempotency_key   text,

  payload           jsonb       NOT NULL DEFAULT '{}',
  metadata          jsonb       NOT NULL DEFAULT '{}',
  provenance        jsonb,

  schema_name       text        NOT NULL,
  schema_version    text        NOT NULL,
  sensitivity       text        NOT NULL,

  occurred_at       timestamptz NOT NULL,
  recorded_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT business_event_type_format CHECK (
    event_type ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'
  ),
  CONSTRAINT business_event_source_domain CHECK (
    source_domain IN (
      'experience',
      'business_administration',
      'commerce',
      'operations',
      'finance',
      'data',
      'intelligence',
      'control_loop'
    )
  ),
  CONSTRAINT business_event_actor_type CHECK (
    actor_type IS NULL OR actor_type IN ('user','service','system','external')
  ),
  CONSTRAINT business_event_sensitivity CHECK (
    sensitivity IN ('public','internal','confidential','restricted','highly_restricted')
  ),
  CONSTRAINT business_event_actor_pair CHECK (
    (actor_type IS NULL AND actor_id IS NULL) OR actor_type IS NOT NULL
  ),
  CONSTRAINT business_event_idempotency_nonblank CHECK (
    idempotency_key IS NULL OR length(btrim(idempotency_key)) > 0
  )
);

CREATE INDEX business_event_ledger_scope_time_idx
  ON events.business_event_ledger (tenant_id, workspace_id, occurred_at DESC);

CREATE INDEX business_event_ledger_correlation_idx
  ON events.business_event_ledger (tenant_id, workspace_id, correlation_id, occurred_at);

CREATE INDEX business_event_ledger_aggregate_idx
  ON events.business_event_ledger (
    tenant_id, workspace_id, source_domain, aggregate_type, aggregate_id, occurred_at
  );

CREATE INDEX business_event_ledger_type_version_idx
  ON events.business_event_ledger (
    tenant_id, workspace_id, event_type, event_version, occurred_at DESC
  );

CREATE UNIQUE INDEX business_event_ledger_idempotency_idx
  ON events.business_event_ledger (
    tenant_id, workspace_id, source_domain, source_service, idempotency_key
  )
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE events.business_event_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE events.business_event_ledger FORCE ROW LEVEL SECURITY;

CREATE POLICY business_event_ledger_isolation
  ON events.business_event_ledger
  USING (
    tenant_id = current_setting('app.tenant_id', true)::uuid
    AND workspace_id = current_setting('app.workspace_id', true)::uuid
  )
  WITH CHECK (
    tenant_id = current_setting('app.tenant_id', true)::uuid
    AND workspace_id = current_setting('app.workspace_id', true)::uuid
  );

CREATE OR REPLACE FUNCTION events.forbid_business_event_ledger_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'events.business_event_ledger is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'raise_exception';
END;
$$;

CREATE TRIGGER forbid_business_event_ledger_mutation
  BEFORE UPDATE OR DELETE ON events.business_event_ledger
  FOR EACH ROW EXECUTE FUNCTION events.forbid_business_event_ledger_mutation();

INSERT INTO _migrations (filename) VALUES ('0171_create_business_event_ledger.sql')
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
