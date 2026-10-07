-- Migration: 0174_add_adi_recommendation_risk_validity
-- P0-3 (owner rulings Q1, Q2, Q5, Q6): ADI authors the risk classification and the
-- temporal-validity facts of a recommendation as part of the Decision Package.
--
--   risk_class         low | medium | high | critical  (implementation vocabulary;
--                      not frozen in a locked spec). NULL = unclassified (legacy or
--                      not yet derived); consumers treat NULL as high risk (P0-2).
--   is_time_sensitive  explicit fact. NULL = unknown (legacy) and is never read as
--                      false by consumers.
--   valid_until        end of validity; MUST be present when is_time_sensitive.
--   twin_snapshot_id   soft UUID reference to the Digital Twin snapshot the
--                      recommendation was computed from. Deliberately NO foreign key:
--                      ADI/ABA do not take a database dependency on Digital Twin state.
--
-- Additive and nullable; no existing row is changed or back-filled with a guess.
-- Guards: a published version's four facts are immutable, and risk_class may be raised
-- but never lowered through an UPDATE (a downgrade needs a future governed exception
-- path with reason, authority and audit evidence).
-- Re-runnable: IF NOT EXISTS / DROP IF EXISTS; the runner also skips applied files.

BEGIN;

ALTER TABLE ai_decision_intelligence.decision_recommendation_versions
  ADD COLUMN IF NOT EXISTS risk_class        text,
  ADD COLUMN IF NOT EXISTS is_time_sensitive boolean,
  ADD COLUMN IF NOT EXISTS valid_until       timestamptz,
  ADD COLUMN IF NOT EXISTS twin_snapshot_id  uuid;

ALTER TABLE ai_decision_intelligence.decision_recommendation_versions
  DROP CONSTRAINT IF EXISTS decision_recommendation_versions_risk_class_check;
ALTER TABLE ai_decision_intelligence.decision_recommendation_versions
  ADD CONSTRAINT decision_recommendation_versions_risk_class_check
  CHECK (risk_class IS NULL OR risk_class IN ('low','medium','high','critical'));

ALTER TABLE ai_decision_intelligence.decision_recommendation_versions
  DROP CONSTRAINT IF EXISTS decision_recommendation_versions_time_sensitive_validity_check;
ALTER TABLE ai_decision_intelligence.decision_recommendation_versions
  ADD CONSTRAINT decision_recommendation_versions_time_sensitive_validity_check
  CHECK (is_time_sensitive IS NOT TRUE OR valid_until IS NOT NULL);

COMMENT ON COLUMN ai_decision_intelligence.decision_recommendation_versions.risk_class IS
  'Risk class authored by ADI (low|medium|high|critical). NULL = unclassified; treated as high by consumers.';
COMMENT ON COLUMN ai_decision_intelligence.decision_recommendation_versions.is_time_sensitive IS
  'Explicit time-sensitivity fact. NULL = unknown (legacy); never interpreted as false.';
COMMENT ON COLUMN ai_decision_intelligence.decision_recommendation_versions.valid_until IS
  'End of validity. Required when is_time_sensitive; enforced by consumers whenever present.';
COMMENT ON COLUMN ai_decision_intelligence.decision_recommendation_versions.twin_snapshot_id IS
  'Soft UUID reference to the Digital Twin snapshot used; intentionally not a foreign key.';

CREATE OR REPLACE FUNCTION ai_decision_intelligence.enforce_recommendation_risk_validity_integrity()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  old_rank integer;
  new_rank integer;
BEGIN
  IF OLD.status = 'published' AND (
       NEW.risk_class IS DISTINCT FROM OLD.risk_class OR
       NEW.is_time_sensitive IS DISTINCT FROM OLD.is_time_sensitive OR
       NEW.valid_until IS DISTINCT FROM OLD.valid_until OR
       NEW.twin_snapshot_id IS DISTINCT FROM OLD.twin_snapshot_id
     ) THEN
    RAISE EXCEPTION 'ai_decision_intelligence.decision_recommendation_versions: risk and validity facts of a published version are immutable'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF OLD.risk_class IS NOT NULL THEN
    old_rank := CASE OLD.risk_class WHEN 'low' THEN 1 WHEN 'medium' THEN 2 WHEN 'high' THEN 3 WHEN 'critical' THEN 4 END;
    new_rank := CASE NEW.risk_class WHEN 'low' THEN 1 WHEN 'medium' THEN 2 WHEN 'high' THEN 3 WHEN 'critical' THEN 4 END;
    IF new_rank IS NULL OR new_rank < old_rank THEN
      RAISE EXCEPTION 'ai_decision_intelligence.decision_recommendation_versions: risk_class may be raised but not lowered or cleared'
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_recommendation_risk_validity_integrity
  ON ai_decision_intelligence.decision_recommendation_versions;
CREATE TRIGGER enforce_recommendation_risk_validity_integrity
  BEFORE UPDATE ON ai_decision_intelligence.decision_recommendation_versions
  FOR EACH ROW EXECUTE FUNCTION ai_decision_intelligence.enforce_recommendation_risk_validity_integrity();

INSERT INTO _migrations (filename) VALUES ('0174_add_adi_recommendation_risk_validity.sql')
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
