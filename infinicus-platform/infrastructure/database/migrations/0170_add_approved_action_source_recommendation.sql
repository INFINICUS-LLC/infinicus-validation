-- Migration: 0170_add_approved_action_source_recommendation
-- Closes a correlation gap found while wiring the frontend's Decision
-- History / Approved Business Action / Outcome Monitoring views to real
-- data: approved_business_action.approved_actions has never stored which
-- ai_decision_intelligence.decision_recommendations it came from.
--
-- BusinessDecisionRecommendationService.startChoiceReview() builds a
-- fresh ADI publication package from scratch on every approval (by
-- design, matching the layer's event/handoff contract) with no column
-- anywhere persisting a path back to the originating recommendation —
-- the two are connected only by the order application code happens to
-- run in, not by anything a later query can follow. This is why
-- getHistory() has shipped with chosen/outcomeNotes hardcoded to null
-- since it was written (see that function's own doc comment) — there was
-- nothing to query.
--
-- Nullable and additive: every existing approved_actions row gets NULL
-- here (that history is genuinely unrecoverable, which is honest — we
-- do not backfill a guess) and all existing constraints/behavior are
-- unaffected. New approvals populate it going forward.
--
-- DROP ... IF EXISTS / ON CONFLICT DO NOTHING keep this rerunnable; the
-- runner also skips files already recorded in _migrations.

BEGIN;

ALTER TABLE approved_business_action.approved_actions
  ADD COLUMN IF NOT EXISTS source_recommendation_id uuid
    REFERENCES ai_decision_intelligence.decision_recommendations(id) ON DELETE SET NULL;

-- getHistory() looks this up in bulk (one IN-list query per request, not
-- one query per decision) — this index is what keeps that query cheap as
-- approved_actions grows.
CREATE INDEX IF NOT EXISTS approved_actions_source_recommendation_id_idx
  ON approved_business_action.approved_actions (source_recommendation_id)
  WHERE source_recommendation_id IS NOT NULL;

INSERT INTO _migrations (filename) VALUES ('0170_add_approved_action_source_recommendation.sql')
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
