-- CL-ACT-06E CANDIDATE SCHEMA — DESIGN REVIEW ONLY.
-- This file is deliberately outside infrastructure/database/migrations.
-- Do not execute until owner approves authority policy, domain ownership,
-- retention, hashing, migration allocation and permission custody.
BEGIN;
CREATE TABLE continuous_learning.shadow_control_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenancy.tenants(id),
  workspace_id uuid NOT NULL REFERENCES tenancy.workspaces(id),
  business_id uuid NOT NULL REFERENCES platform.businesses(id),
  operator_id uuid NOT NULL REFERENCES identity.users(id),
  approver_id uuid REFERENCES identity.users(id),
  assignment_id uuid REFERENCES approved_business_action.approver_assignments(id),
  assignment_version_id uuid REFERENCES approved_business_action.approver_assignment_versions(id),
  control_id uuid NOT NULL,
  control_version integer NOT NULL CHECK (control_version > 0),
  event_type text NOT NULL CHECK (event_type IN ('REQUESTED','APPROVED','REVOKED','REFUSED','EVALUATED')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  source_digest text NOT NULL CHECK (source_digest ~ '^sha256:[0-9a-f]{64}$'),
  record_digest text NOT NULL CHECK (record_digest ~ '^sha256:[0-9a-f]{64}$'),
  predecessor_digest text CHECK (predecessor_digest IS NULL OR predecessor_digest ~ '^sha256:[0-9a-f]{64}$'),
  reason_codes text[] NOT NULL DEFAULT '{}',
  release_authorized boolean NOT NULL DEFAULT false CHECK (release_authorized = false),
  learning_applied boolean NOT NULL DEFAULT false CHECK (learning_applied = false),
  mutations_permitted boolean NOT NULL DEFAULT false CHECK (mutations_permitted = false),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT shadow_audit_non_self_approval CHECK (event_type <> 'APPROVED' OR
    (approver_id IS NOT NULL AND operator_id <> approver_id AND assignment_id IS NOT NULL AND assignment_version_id IS NOT NULL)),
  CONSTRAINT shadow_audit_idempotency UNIQUE (tenant_id, workspace_id, business_id, idempotency_key)
);
-- A canonical writer must verify actor/assignment scopes and database clock;
-- individual FKs above alone do NOT prove composite tenant authorization.
CREATE FUNCTION continuous_learning.reject_shadow_audit_modification()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'shadow audit is append-only' USING ERRCODE = '42501'; END $$;
CREATE TRIGGER shadow_audit_no_update BEFORE UPDATE ON continuous_learning.shadow_control_audit_events
FOR EACH ROW EXECUTE FUNCTION continuous_learning.reject_shadow_audit_modification();
CREATE TRIGGER shadow_audit_no_delete BEFORE DELETE ON continuous_learning.shadow_control_audit_events
FOR EACH ROW EXECUTE FUNCTION continuous_learning.reject_shadow_audit_modification();
ALTER TABLE continuous_learning.shadow_control_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE continuous_learning.shadow_control_audit_events FORCE ROW LEVEL SECURITY;
-- Intentionally no INSERT/SELECT/UPDATE/DELETE policies or app-role GRANT.
-- Explicitly REVOKE TRUNCATE from application roles in an approved migration;
-- table owner/superuser may bypass triggers or force changes. Strong immutability
-- requires independently reviewed ownership, privileges, and audit anchoring.
ROLLBACK; -- Not an executable migration or production change.
