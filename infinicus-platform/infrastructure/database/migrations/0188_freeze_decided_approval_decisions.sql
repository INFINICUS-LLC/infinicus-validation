-- Migration: 0188_freeze_decided_approval_decisions
-- P0-6.0 (owner ruling O-14): a FINALIZED approval decision is immutable in every column, not only in `status`.
--
-- Why: `approval_decisions.updated_at` of an approved_with_modifications decision is the authoritative modification time (B2c ruling:
-- `modifiedAt`), and the decided state is where ABA exercises its approval authority. Until now `enforce_decision_immutability()` rejected
-- only a change of STATUS on a decided row, so a non-status UPDATE (none exists in production code) could still re-stamp `updated_at`
-- (the `set_updated_at` trigger writes now()). From this migration ANY UPDATE of a decided decision, or of a decided decision version, is rejected.
--
-- Scope: FUTURE mutation guard only. No data is read, rewritten or backfilled; no existing row changes; no table, column, index or policy
-- is touched. The valid transition INTO the decided state (OLD.status not decided) is unchanged, so the existing approval flow
-- (`decide()` updates the decision and its version while they are still in a non-decided state) is preserved. RLS and authority behaviour
-- are untouched (the functions stay SECURITY INVOKER; the triggers already exist and are only given new function bodies).
-- A privileged operator who must change a decided row has to disable the trigger explicitly (session_replication_role = replica or
-- ALTER TABLE ... DISABLE TRIGGER), which is a deliberate, auditable act and the same pattern the test suites use for teardown.
-- Idempotent: CREATE OR REPLACE FUNCTION only.

BEGIN;

CREATE OR REPLACE FUNCTION approved_business_action.enforce_decision_immutability()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('approved','approved_with_modifications','rejected') THEN
    RAISE EXCEPTION 'approved_business_action.approval_decisions: decided decisions are immutable'
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION approved_business_action.enforce_decision_version_immutability()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('approved','approved_with_modifications','rejected') THEN
    RAISE EXCEPTION 'approved_business_action.approval_decision_versions: decided decision versions are immutable'
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION approved_business_action.enforce_decision_immutability() IS
  'P0-6.0: rejects EVERY update of a decided (approved / approved_with_modifications / rejected) approval decision, so its updated_at - the authoritative decision/modification time - cannot be re-stamped. The transition into the decided state is unaffected.';

INSERT INTO _migrations (filename) VALUES ('0188_freeze_decided_approval_decisions.sql')
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
