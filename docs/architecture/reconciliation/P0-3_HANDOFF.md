# P0-3 — risk_class / valid_until / stale-decision controls: handoff (Block 4)

Status: **P0-3 implementation complete on `main`** (Blocks 1, 2, 2b, 3 merged: #38, #39, #41, #42). This is the documentation and handoff block. It records the purpose, architecture, dependencies, configuration, usage, extension notes, compatibility impact, known limitations and the inputs for the separate controlled deployment review. Locked specs unchanged; owner rulings of 2026-10-07 (Q1-Q7 and the follow-up rulings) are applied. Companion documents: `P0-3_RISK_CLASS_VALID_UNTIL_RECONCILIATION.md` (design record), `P0-2_ACTION_RISK_POLICY.md`, `P0-1_APPROVAL_AUTHORITY.md`.

## 1. Purpose
Approval must be role- and policy-controlled and must not silently approve a stale or expired decision (locked ABA §§8, 11, 12, 27). P0-3 persists the risk and temporal-validity facts of a recommendation where the spec says they belong (the ADI Decision Package), snapshots them into ABA, and makes ABA refuse to approve when they say it must not.

## 2. Architecture overview
```
ADI authors (migration 0174, decision_recommendation_versions)
  risk_class        low|medium|high|critical   = MAX(persisted risk-profile floor, validated generator level, human raise)
  is_time_sensitive true|false|NULL            false only after a COMPLETE evaluation; NULL = unknown, never false
  valid_until       timestamptz                required when time-sensitive; enforced whenever present
  twin_snapshot_id  uuid (soft reference, no FK)
        |  published recommendation version  (immutable; risk raise-only before publication)
        v
ABA snapshots (migration 0175, action_review_package_versions, append-only)
  copy of the four facts + source_recommendation_version_id (lineage FK)
        |  ABA copies; it never derives or recalculates
        v
submitApprovalDecision (DecisionWorkflowService)
  1. authority (P0-1)  2. risk policy (P0-2, role tier vs persisted risk_class)  3. gate (P0-3, approve/approve_with_modifications only)
  reject: needs authority only; never blocked by the facts
```
Ownership: ADI owns the facts; ABA owns the approval gating; Digital Twin state is only read (`DigitalTwinSnapshotRepository.assessFreshness`), never mutated, and there is no ABA to Digital Twin foreign key.

Gate outcomes (`ApprovalBlockedError`, HTTP 409, message names the code and "recovery: RECALCULATE DECISION"):

| Code | When |
|---|---|
| `EXPIRED` | `valid_until` <= database `now()` (regardless of `is_time_sensitive`; inclusive; invalid date also blocks) |
| `TIME_SENSITIVITY_UNKNOWN` | `is_time_sensitive` is NULL |
| `TIME_SENSITIVE_WITHOUT_VALIDITY` | `is_time_sensitive` TRUE and no `valid_until` |
| `STALE` | a newer PUBLISHED Twin snapshot exists for the same business (drafts and unpublished do not count) |
| `TWIN_SNAPSHOT_UNVERIFIABLE` | a `twin_snapshot_id` is present but unknown, for another business, or never published |
| `REVIEW_FACTS_MISSING` | the review has no version |
Allowed: `is_time_sensitive` FALSE with no `valid_until`; TRUE with a future `valid_until`; no `twin_snapshot_id` means nothing to compare.

## 3. Files
- Migrations: `0174_add_adi_recommendation_risk_validity.sql`, `0175_add_aba_review_version_snapshot.sql`.
- Pure logic (workflow package): `recommendationAuthoring.ts` (`deriveRiskClass`, `determineTimeValidity`), `approvalRiskPolicy.ts` (P0-2), `approvalGate.ts`.
- Services: `BusinessDecisionRecommendationService.recommend` (authoring), `DecisionWorkflowService.createReview` / `submitApprovalDecision` (snapshot copy, enforcement).
- Repositories: `DecisionRecommendationRepository` (`createRecommendation` with floor, `raiseRiskClass`, `normalizeRiskValidity`, `maxRiskClass`), `ActionReviewRepository` (`resolvePublishedSnapshot`, `getLatestVersion`, `getLatestVersionWithClock`), `DigitalTwinSnapshotRepository.assessFreshness`.
- API: `ApprovalBlockedError` -> 409, `ApprovalPolicyDeniedError` -> 403 (`apps/api/src/errors.ts`); the decision route accepts no risk or validity input.

## 4. Dependencies
Depends on P0-1 (authority), P0-2 (role tiers), BUILD-33 only through shared migration numbering (0172/0173 precede 0174/0175), and on the Digital Twin snapshot tables for `assessFreshness`. Nothing here depends on, or enables, ABA to BO wiring.

## 5. Configuration
No environment variables or feature flags. Policy values live in code and are injectable: `DEFAULT_APPROVAL_RISK_POLICY` (low->cashier, medium->manager, high/critical->business owner; unclassified treated as high) via the `DecisionWorkflowService` constructor; the validity-signal evaluator via the last `BusinessDecisionRecommendationService` constructor parameter (`defaultValiditySignalEvaluator`). The risk vocabulary `low|medium|high|critical` is an implementation vocabulary (not frozen in a locked spec); changing it needs a versioned implementation-contract migration.

## 6. Usage examples
```ts
// ADI authoring (BusinessDecisionRecommendationService.recommend does this):
const risk = deriveRiskClass({ authoredRiskLevel: item.risk_level });          // MAX; invalid with no floor => null
const validity = determineTimeValidity(await evaluator(ctx, businessId));       // false only if every source evaluated
await recommendations.createRecommendation(ctx, biz, caseId, code, text, chosenAlternativeId,
  { riskClass: risk.riskClass, isTimeSensitive: validity.isTimeSensitive, validUntil: validity.validUntil, twinSnapshotId });
await recommendations.raiseRiskClass(ctx, versionId, 'high');                   // human raise, pre-publication only

// ABA: review creation snapshots the published facts; approval reads only the persisted snapshot
const review = await workflow.createReview(ctx, biz, { intakePackageId, reviewCode, summary });
await workflow.submitApprovalDecision(ctx, biz, { reviewPackageId: review.id, assignmentCode, decisionCode, summary, outcome: 'approve' });
// -> 409 ApprovalBlockedError (EXPIRED | STALE | ...) when the persisted facts forbid approval; reject always works
```

## 7. Compatibility impact
- **Pre-0174 recommendations and any review created from them have NULL facts.** They cannot be approved (`TIME_SENSITIVITY_UNKNOWN`) until the decision is recalculated; they can still be rejected. No value was back-filled or fabricated, and none will be.
- API approvals by manager/`approver`-role holders are denied for unclassified decisions (P0-2); owner-tier approvers are unaffected.
- A recommendation goes stale when the business publishes a newer Twin snapshot (the Twin refresh route, or a recompute after the 1-hour cache). The user must recalculate.
- The `SubmitApprovalInput.riskClass` field (P0-2) no longer exists; callers can no longer influence risk or validity.

## 8. Known limitations
1. **No dedicated "recalculate decision" operation exists.** Today recovery means asking for a new recommendation (`recommend`) and starting a new review. A first-class recalculation (linking the new recommendation to the blocked one) is not built.
2. Twin-grounded recommendations have no data source yet for evidence expiry, forecast horizon, action window or a policy time-sensitivity marker; all evaluate to "none applies", so `is_time_sensitive` is authored `false` with the basis recorded in a `risk_validity_basis` rationale. Staleness is the temporal guard.
3. The generator's `risk_level` is model output; the deterministic floor only exists when the chosen alternative has persisted risk profiles (the twin flow creates none). Humans can raise, nothing lowers.
4. The staleness rule is strict (any newer published snapshot); no materiality thresholds exist (separate policy decision required).
5. No override, no `approval_exceptions` use, no audit events for approve/deny/expire (P0-4), no `AuthorizedActionPackage` (P0-5), no ABA to BO wiring (P0-6).
6. Staleness compares `effective_at` of snapshots of the same business; a snapshot with an `effective_at` far in the future would mark everything older as stale.

## 9. Future extension notes
Governed downgrade/override path after P0-4 provides audit events, actor identity, permission, reason, expiry, scope and immutable evidence; materiality thresholds by explicit policy; real validity signal sources (evidence expiry, forecast horizon, deadline windows, policy markers); a first-class recalculation link; an audit event for every gate block.

## 10. Inputs for the separate controlled deployment review (NOT a deployment; nothing is authorised)
Live Supabase ends at `0169`; `main` is at `0175`. Frozen-range evidence (Migration Allocation Policy rule 7):
- predecessor final migration: `0173_harden_eventing_scope.sql`; new range this build: `0174`-`0175`.
- SHA-256 of `0001`-`0173` concatenated in filename order: `945f0a52c0408d88bb737b6a35f7b29d6ec8dadb0548081137611a2631c0a4c2`.
- SHA-256 per file (verify with `sha256sum` on `main` before the review):
  - `0170_add_approved_action_source_recommendation.sql` `d1b392389ed801067e7d3257ba157d2c62425061f13c970de53d234edf007272`
  - `0171_create_da_webhook_token_lookup.sql` `600c3a1d8b2d6095e933e1ed2f7a62f8a847e300958188a5e64668c69d83dac1`
  - `0172_create_business_event_ledger.sql` `f038a448b8d170efc6160bed591c9320464984383e3dc293966e7b4b4ea9d800`
  - `0173_harden_eventing_scope.sql` `ea779db00bf2c33934b52eb7d543ea82d16c72c641bf4ca73231aeff09b754ed`
  - `0174_add_adi_recommendation_risk_validity.sql` `54dffa00c377155f41a28e62c2ae264805d80652b8a7dfc69e34744b7bd7974c`
  - `0175_add_aba_review_version_snapshot.sql` `8a24ae97018cf0f61c332eaadaab9b942157cb2deb9ab1d6c3d6e8408f2e630b`
- empty-install result: the migration gate applies 0001-0175 from an empty database (CI and local); re-run result: idempotent (all skipped).
The review should cover (per owner instruction): exact SQL of 0170-0175; live row compatibility (0174 adds nullable columns and a CHECK that existing rows satisfy; 0175 adds nullable columns, a lineage FK and an index; neither rewrites existing rows; 0173 replaces RLS policies on five event tables and adds a trigger); backup and recovery status; application-version compatibility (the deployed application must understand the new columns and the 409/403 behaviour before or with the migration; the new code tolerates NULL facts); a forward-only rollback strategy (no down migrations; plan = forward fix migration or point-in-time recovery); migration order and validation after each step; post-migration smoke and RLS checks.
