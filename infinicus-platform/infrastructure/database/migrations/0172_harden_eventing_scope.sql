-- Migration: 0172_harden_eventing_scope
-- BUILD-33 — additive tenant/workspace hardening for the pre-existing event
-- transport tables. Historical migrations remain untouched.

BEGIN;

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

ALTER TABLE events.event_subscriptions
  DROP CONSTRAINT IF EXISTS event_subscriptions_status_check,
  ADD CONSTRAINT event_subscriptions_status_check
    CHECK (status IN ('active','paused','disabled','failed')),
  ADD CONSTRAINT event_subscriptions_ordering_mode_check
    CHECK (ordering_mode IN ('none','aggregate','business','strict')),
  ADD CONSTRAINT event_subscriptions_timeout_check
    CHECK (timeout_seconds > 0 AND timeout_seconds <= 3600);

ALTER TABLE events.event_delivery_attempts
  ADD CONSTRAINT event_delivery_attempts_status_check
    CHECK (status IN ('started','succeeded','failed','timed_out','cancelled'));

CREATE INDEX IF NOT EXISTS inbox_events_scope_idx
  ON events.inbox_events (tenant_id, workspace_id, event_id, consumer_name);

CREATE INDEX IF NOT EXISTS dead_letter_events_scope_idx
  ON events.dead_letter_events (tenant_id, workspace_id, last_failed_at DESC);

CREATE INDEX IF NOT EXISTS event_subscriptions_scope_idx
  ON events.event_subscriptions (tenant_id, workspace_id, status);

CREATE INDEX IF NOT EXISTS event_delivery_attempts_scope_idx
  ON events.event_delivery_attempts (tenant_id, workspace_id, outbox_event_id, attempt_number);

ALTER TABLE events.outbox_events FORCE ROW LEVEL SECURITY;
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
    tenant_id = current_setting('app.tenant_id', true)::uuid
    AND workspace_id = current_setting('app.workspace_id', true)::uuid
  )
  WITH CHECK (
    tenant_id = current_setting('app.tenant_id', true)::uuid
    AND workspace_id = current_setting('app.workspace_id', true)::uuid
  );

DROP POLICY IF EXISTS inbox_events_isolation ON events.inbox_events;
CREATE POLICY inbox_events_isolation ON events.inbox_events
  USING (
    tenant_id = current_setting('app.tenant_id', true)::uuid
    AND workspace_id = current_setting('app.workspace_id', true)::uuid
  )
  WITH CHECK (
    tenant_id = current_setting('app.tenant_id', true)::uuid
    AND workspace_id = current_setting('app.workspace_id', true)::uuid
  );

DROP POLICY IF EXISTS dead_letter_events_isolation ON events.dead_letter_events;
CREATE POLICY dead_letter_events_isolation ON events.dead_letter_events
  USING (
    tenant_id = current_setting('app.tenant_id', true)::uuid
    AND workspace_id = current_setting('app.workspace_id', true)::uuid
  )
  WITH CHECK (
    tenant_id = current_setting('app.tenant_id', true)::uuid
    AND workspace_id = current_setting('app.workspace_id', true)::uuid
  );

DROP POLICY IF EXISTS event_subscriptions_isolation ON events.event_subscriptions;
CREATE POLICY event_subscriptions_isolation ON events.event_subscriptions
  USING (
    tenant_id = current_setting('app.tenant_id', true)::uuid
    AND workspace_id = current_setting('app.workspace_id', true)::uuid
  )
  WITH CHECK (
    tenant_id = current_setting('app.tenant_id', true)::uuid
    AND workspace_id = current_setting('app.workspace_id', true)::uuid
  );

DROP POLICY IF EXISTS event_delivery_attempts_isolation ON events.event_delivery_attempts;
CREATE POLICY event_delivery_attempts_isolation ON events.event_delivery_attempts
  USING (
    tenant_id = current_setting('app.tenant_id', true)::uuid
    AND workspace_id = current_setting('app.workspace_id', true)::uuid
  )
  WITH CHECK (
    tenant_id = current_setting('app.tenant_id', true)::uuid
    AND workspace_id = current_setting('app.workspace_id', true)::uuid
  );

INSERT INTO _migrations (filename) VALUES ('0172_harden_eventing_scope.sql')
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
