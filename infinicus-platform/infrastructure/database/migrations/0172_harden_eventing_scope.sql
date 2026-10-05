-- Migration: 0172_harden_eventing_scope
-- BUILD-33 v1.1 — compatibility-preserving event transport scope model.
--
-- Scope semantics:
--   TENANT_WORKSPACE = tenant + workspace owned data
--   TENANT_GLOBAL    = tenant owned, intentionally shared across its workspaces
--   PLATFORM_GLOBAL  = platform control-plane/history, visible only to
--                      privileged relay/system roles that bypass RLS
--
-- Historical rows are preserved in place. Scope is generated from the
-- pre-existing/new tenant_id + workspace_id columns, so legacy NULL scope is
-- explicit rather than silently hidden or rewritten.

BEGIN;

-- ── Add missing ownership metadata without changing historical rows ─────────

ALTER TABLE events.inbox_events
  ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES tenancy.workspaces(id) ON DELETE RESTRICT;

ALTER TABLE events.dead_letter_events
  ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenancy.tenants(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES tenancy.workspaces(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS original_event_id uuid,
  ADD COLUMN IF NOT EXISTS approved_by text,
  ADD COLUMN IF NOT EXISTS replay_event_id uuid;

ALTER TABLE events.event_subscriptions
  ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenancy.tenants(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES tenancy.workspaces(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS supported_versions text[] NOT NULL DEFAULT ARRAY['1.0']::text[],
  ADD COLUMN IF NOT EXISTS consumer_group text,
  ADD COLUMN IF NOT EXISTS ordering_mode text NOT NULL DEFAULT 'aggregate',
  ADD COLUMN IF NOT EXISTS timeout_seconds integer NOT NULL DEFAULT 30;

ALTER TABLE events.event_delivery_attempts
  ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenancy.tenants(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES tenancy.workspaces(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS subscription_id uuid REFERENCES events.event_subscriptions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS consumer_name text,
  ADD COLUMN IF NOT EXISTS worker_id text,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS latency_ms integer,
  ADD COLUMN IF NOT EXISTS failure_code text,
  ADD COLUMN IF NOT EXISTS failure_message text,
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}';

-- ── Generated scope classification ───────────────────────────────────────────
-- Generated columns avoid drift: writers cannot claim one scope while storing
-- incompatible tenant/workspace keys.

ALTER TABLE events.outbox_events
  ADD COLUMN IF NOT EXISTS scope_type text
  GENERATED ALWAYS AS (
    CASE
      WHEN workspace_id IS NULL THEN 'TENANT_GLOBAL'
      ELSE 'TENANT_WORKSPACE'
    END
  ) STORED;

ALTER TABLE events.inbox_events
  ADD COLUMN IF NOT EXISTS scope_type text
  GENERATED ALWAYS AS (
    CASE
      WHEN workspace_id IS NULL THEN 'TENANT_GLOBAL'
      ELSE 'TENANT_WORKSPACE'
    END
  ) STORED;

ALTER TABLE events.dead_letter_events
  ADD COLUMN IF NOT EXISTS scope_type text
  GENERATED ALWAYS AS (
    CASE
      WHEN tenant_id IS NULL THEN 'PLATFORM_GLOBAL'
      WHEN workspace_id IS NULL THEN 'TENANT_GLOBAL'
      ELSE 'TENANT_WORKSPACE'
    END
  ) STORED;

ALTER TABLE events.event_subscriptions
  ADD COLUMN IF NOT EXISTS scope_type text
  GENERATED ALWAYS AS (
    CASE
      WHEN tenant_id IS NULL THEN 'PLATFORM_GLOBAL'
      WHEN workspace_id IS NULL THEN 'TENANT_GLOBAL'
      ELSE 'TENANT_WORKSPACE'
    END
  ) STORED;

ALTER TABLE events.event_delivery_attempts
  ADD COLUMN IF NOT EXISTS scope_type text
  GENERATED ALWAYS AS (
    CASE
      WHEN tenant_id IS NULL THEN 'PLATFORM_GLOBAL'
      WHEN workspace_id IS NULL THEN 'TENANT_GLOBAL'
      ELSE 'TENANT_WORKSPACE'
    END
  ) STORED;

-- ── Lifecycle constraints ────────────────────────────────────────────────────

ALTER TABLE events.event_subscriptions
  DROP CONSTRAINT IF EXISTS event_subscriptions_status_check,
  ADD CONSTRAINT event_subscriptions_status_check
    CHECK (status IN ('active','paused','disabled','failed')),
  ADD CONSTRAINT event_subscriptions_ordering_mode_check
    CHECK (ordering_mode IN ('none','aggregate','business','strict')),
  ADD CONSTRAINT event_subscriptions_timeout_check
    CHECK (timeout_seconds > 0 AND timeout_seconds <= 3600);

-- Historical schema/docs allowed the status vocabulary below, including
-- "started". BUILD-33 preserves those rows for compatibility, but its
-- repository writes one terminal row per completed attempt and never mutates it.
ALTER TABLE events.event_delivery_attempts
  ADD CONSTRAINT event_delivery_attempts_status_check
    CHECK (status IN ('started','succeeded','failed','timed_out','cancelled'));

-- The Stage-2A contract called this table append-only but did not install a
-- database mutation guard. BUILD-33 closes that enforcement gap additively.
CREATE OR REPLACE FUNCTION events.forbid_delivery_attempt_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $
BEGIN
  RAISE EXCEPTION 'events.event_delivery_attempts is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'raise_exception';
END;
$;

DROP TRIGGER IF EXISTS forbid_delivery_attempt_mutation
  ON events.event_delivery_attempts;

CREATE TRIGGER forbid_delivery_attempt_mutation
  BEFORE UPDATE OR DELETE ON events.event_delivery_attempts
  FOR EACH ROW EXECUTE FUNCTION events.forbid_delivery_attempt_mutation();

-- ── Scope-aware indexes ──────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS outbox_events_scope_idx
  ON events.outbox_events (scope_type, tenant_id, workspace_id, available_at, created_at);

CREATE INDEX IF NOT EXISTS inbox_events_scope_idx
  ON events.inbox_events (scope_type, tenant_id, workspace_id, event_id, consumer_name);

CREATE INDEX IF NOT EXISTS dead_letter_events_scope_idx
  ON events.dead_letter_events (scope_type, tenant_id, workspace_id, last_failed_at DESC);

CREATE INDEX IF NOT EXISTS event_subscriptions_scope_idx
  ON events.event_subscriptions (scope_type, tenant_id, workspace_id, status);

CREATE INDEX IF NOT EXISTS event_delivery_attempts_scope_idx
  ON events.event_delivery_attempts (
    scope_type, tenant_id, workspace_id, outbox_event_id, attempt_number
  );

-- ── RLS posture ──────────────────────────────────────────────────────────────
-- Normal application roles can see:
--   * TENANT_WORKSPACE rows for their exact tenant/workspace
--   * TENANT_GLOBAL rows for their tenant
--
-- PLATFORM_GLOBAL rows deliberately have no normal-app policy path. They remain
-- available to the privileged relay/system/admin role through BYPASSRLS.
--
-- NULLIF(...,'') prevents the historical empty-session-variable UUID-cast
-- failure while still failing closed when context is absent.

ALTER TABLE events.outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE events.outbox_events FORCE ROW LEVEL SECURITY;
ALTER TABLE events.inbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE events.inbox_events FORCE ROW LEVEL SECURITY;
ALTER TABLE events.dead_letter_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE events.dead_letter_events FORCE ROW LEVEL SECURITY;
ALTER TABLE events.event_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE events.event_subscriptions FORCE ROW LEVEL SECURITY;
ALTER TABLE events.event_delivery_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE events.event_delivery_attempts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS outbox_events_isolation ON events.outbox_events;
CREATE POLICY outbox_events_isolation ON events.outbox_events
  USING (
    (
      scope_type = 'TENANT_WORKSPACE'
      AND tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
      AND workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    )
    OR
    (
      scope_type = 'TENANT_GLOBAL'
      AND tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    )
  )
  WITH CHECK (
    (
      scope_type = 'TENANT_WORKSPACE'
      AND tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
      AND workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    )
    OR
    (
      scope_type = 'TENANT_GLOBAL'
      AND tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    )
  );

DROP POLICY IF EXISTS inbox_events_isolation ON events.inbox_events;
CREATE POLICY inbox_events_isolation ON events.inbox_events
  USING (
    (
      scope_type = 'TENANT_WORKSPACE'
      AND tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
      AND workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    )
    OR
    (
      scope_type = 'TENANT_GLOBAL'
      AND tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    )
  )
  WITH CHECK (
    (
      scope_type = 'TENANT_WORKSPACE'
      AND tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
      AND workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    )
    OR
    (
      scope_type = 'TENANT_GLOBAL'
      AND tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    )
  );

DROP POLICY IF EXISTS dead_letter_events_isolation ON events.dead_letter_events;
CREATE POLICY dead_letter_events_isolation ON events.dead_letter_events
  USING (
    (
      scope_type = 'TENANT_WORKSPACE'
      AND tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
      AND workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    )
    OR
    (
      scope_type = 'TENANT_GLOBAL'
      AND tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    )
  )
  WITH CHECK (
    (
      scope_type = 'TENANT_WORKSPACE'
      AND tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
      AND workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    )
    OR
    (
      scope_type = 'TENANT_GLOBAL'
      AND tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    )
  );

DROP POLICY IF EXISTS event_subscriptions_isolation ON events.event_subscriptions;
CREATE POLICY event_subscriptions_isolation ON events.event_subscriptions
  USING (
    (
      scope_type = 'TENANT_WORKSPACE'
      AND tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
      AND workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    )
    OR
    (
      scope_type = 'TENANT_GLOBAL'
      AND tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    )
  )
  WITH CHECK (
    (
      scope_type = 'TENANT_WORKSPACE'
      AND tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
      AND workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    )
    OR
    (
      scope_type = 'TENANT_GLOBAL'
      AND tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    )
  );

DROP POLICY IF EXISTS event_delivery_attempts_isolation ON events.event_delivery_attempts;
CREATE POLICY event_delivery_attempts_isolation ON events.event_delivery_attempts
  USING (
    (
      scope_type = 'TENANT_WORKSPACE'
      AND tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
      AND workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    )
    OR
    (
      scope_type = 'TENANT_GLOBAL'
      AND tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    )
  )
  WITH CHECK (
    (
      scope_type = 'TENANT_WORKSPACE'
      AND tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
      AND workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    )
    OR
    (
      scope_type = 'TENANT_GLOBAL'
      AND tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    )
  );

INSERT INTO _migrations (filename) VALUES ('0172_harden_eventing_scope.sql')
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
