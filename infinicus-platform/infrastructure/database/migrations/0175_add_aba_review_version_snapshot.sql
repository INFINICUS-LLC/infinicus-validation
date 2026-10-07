-- Migration: 0175_add_aba_review_version_snapshot
-- P0-3 (owner rulings Q1, Q5, Q6): ABA snapshots the PUBLISHED risk/validity facts of the
-- ADI recommendation version it reviews. ABA consumes these; it never authors or
-- recalculates risk_class (Q1) and never owns Digital Twin state (Q6).
--
-- action_review_package_versions is append-only (forbid_mutation trigger), so the snapshot
-- is written at insert time and can never be changed afterwards.
--
--   source_recommendation_version_id  lineage to the ADI version (real FK, same layer-chain
--                                     precedent as 0170; RESTRICT because this table is
--                                     append-only and ADI versions are never deleted)
--   risk_class / is_time_sensitive / valid_until / twin_snapshot_id   copies (no FK on the
--                                     twin reference)
--
-- No time-sensitivity CHECK here on purpose: ABA must be able to record what intake gave it
-- and then BLOCK approval (time-sensitive without valid_until, expired, stale) rather than
-- fail to record it. Additive and nullable; no back-fill.

BEGIN;

ALTER TABLE approved_business_action.action_review_package_versions
  ADD COLUMN IF NOT EXISTS source_recommendation_version_id uuid
    REFERENCES ai_decision_intelligence.decision_recommendation_versions(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS risk_class        text,
  ADD COLUMN IF NOT EXISTS is_time_sensitive boolean,
  ADD COLUMN IF NOT EXISTS valid_until       timestamptz,
  ADD COLUMN IF NOT EXISTS twin_snapshot_id  uuid;

ALTER TABLE approved_business_action.action_review_package_versions
  DROP CONSTRAINT IF EXISTS action_review_package_versions_risk_class_check;
ALTER TABLE approved_business_action.action_review_package_versions
  ADD CONSTRAINT action_review_package_versions_risk_class_check
  CHECK (risk_class IS NULL OR risk_class IN ('low','medium','high','critical'));

CREATE INDEX IF NOT EXISTS action_review_package_versions_source_recommendation_version_idx
  ON approved_business_action.action_review_package_versions (source_recommendation_version_id)
  WHERE source_recommendation_version_id IS NOT NULL;

COMMENT ON COLUMN approved_business_action.action_review_package_versions.risk_class IS
  'Snapshot of the published ADI risk_class. NULL = unclassified; treated as high risk by approval policy (P0-2).';
COMMENT ON COLUMN approved_business_action.action_review_package_versions.is_time_sensitive IS
  'Snapshot of the ADI time-sensitivity fact. NULL = unknown; never interpreted as false.';

INSERT INTO _migrations (filename) VALUES ('0175_add_aba_review_version_snapshot.sql')
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
