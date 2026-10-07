# P0-3 — risk_class / valid_until: written reconciliation (NO code, NO migration yet)

Status: **reconciliation only**, as required by the plan ("first: a written reconciliation of the locked ABA §§8, 11, 12 requirements with the data model; any mismatch goes to the user as an amendment request"). Locked specs are not changed. Baseline: `main` after #34 (P0-2), migrations 0001–0171.

## 1. What the locked spec requires

| Spec | Requirement |
|---|---|
| §4 Primary input | The Decision Package from ADI carries: risk, confidence, reversibility, Twin snapshot ID, Simulation run ID, evidence gaps, **valid-until**, **freshness status**, model/version metadata. |
| §7 Pending approvals | Each row shows risk, valid until, reversibility, required approver, evidence completeness, current status. |
| §8 Permissions | Approval is role- and policy-controlled; thresholds may depend on cost, **risk**, reversibility, decision class, strategic impact, automation level. |
| §11 Stale decision | A materially stale decision must not be silently approved (example: "STALE — Twin state changed after recommendation"); required path is RECALCULATE DECISION. |
| §12 Valid-until | Time-sensitive recommendations include VALID UNTIL; expired ones become EXPIRED; approval is blocked until refreshed **unless policy allows an explicit manual override**. |
| §27 | Higher-risk actions at lower maturity need stronger human review. |

## 2. What the data model has today (read from migrations 0077–0106, 0170)

| Need | Present | Gap |
|---|---|---|
| Risk of the recommended option | `ai_decision_intelligence.alternative_risk_profiles(risk_code …)` per alternative version | No normalised **risk class** on the recommendation or on ABA's review package. |
| Confidence | `decision_confidence_scores` (0..1) | Present. |
| Evidence freshness | `decision_evidence_quality.freshness_seconds` (per evidence item) | No package-level freshness status. |
| Valid-until | none | **No column anywhere** (ADI recommendation versions, ABA intake, review package, approved action). |
| Twin snapshot at recommendation time | only inside `evidence_reference` jsonb | No typed reference usable for a stale check. |
| Expiry/override record | `approved_business_action.approval_exceptions` (0100) exists | Not tied to expiry/staleness; unused by the decision path. |
| Where approval is decided | `submitApprovalDecision` (P0-2) takes a trusted `riskClass` parameter that no persisted source supplies; API approvals are therefore "unclassified → high". | The trusted source is what P0-3 must provide. |

## 3. Proposed mapping (additive, nullable, no edits to 0001–0171)

Ownership follows the spec: risk, valid-until and freshness are facts of the **Decision Package that ADI authors** (§4); ABA **consumes** them and owns the approval gating state (§§11–12). ABA never authors risk.

1. **ADI** — `ai_decision_intelligence.decision_recommendation_versions` gains `risk_class` (`low|medium|high|critical`), `valid_until timestamptz`, `twin_snapshot_id uuid` (soft reference, no cross-layer FK), all NULL-able. Published versions stay immutable (columns are set when the version is created, before publication).
2. **ABA** — `approved_business_action.action_review_package_versions` gains a **snapshot copy** taken at review creation: `risk_class`, `valid_until`, `source_recommendation_version_id` (FK to the ADI version, same pattern as 0170), `twin_snapshot_id`. The snapshot is append-only like its table.
3. **Enforcement** in `submitApprovalDecision`, evaluated server-side from the persisted review version (the caller-supplied `riskClass` parameter from P0-2 is removed from the trusted path):
   - risk class: from the snapshot; absent ⇒ unclassified ⇒ high (P0-2 fail-closed unchanged);
   - **expired**: `valid_until` ≤ database `now()` ⇒ approve / approve-with-modifications refused (`ApprovalBlockedError`, HTTP 409, status EXPIRED); **reject always allowed**;
   - **stale**: a published Twin snapshot for the business newer than `twin_snapshot_id` exists ⇒ refused as STALE with the RECALCULATE path;
   - missing `valid_until` on an action whose policy marks it time-sensitive ⇒ refused (fail closed); missing `valid_until` otherwise is allowed and recorded as "no expiry";
   - override: **off by default**. If enabled later it must go through `approval_exceptions` with approver, reason, expiry, and (P0-4) an audit event. P0-3 ships no override.
4. Two migrations, one per owning layer (ADI columns; ABA columns), kept additive and re-runnable like 0170.

## 4. Migration number (rule: do not pre-claim)

Inspected: `main` = 0171. PR #22 (BUILD-33) now carries **0172 and 0173** on its branch (renumbered; not on main). PR #14 merged as 0171. No other open migration-bearing PR. Under `MIGRATION-ALLOCATION-POLICY.md` the next free numbers are **0174, 0175**, but they are **not claimed**: they are only valid if PR #22 merges first. If P0-3 would merge before #22, #22 renumbers again. **Order to be decided by the owner**; I create no migration until then.

## 5. Mismatches and questions that need an owner answer (amendment candidates)

| # | Question | Why it matters | My recommendation |
|---|---|---|---|
| Q1 | **Who authors `risk_class`?** ADI (a field of the Decision Package, per §4) is the only spec-consistent owner. Today ADI has no classification logic. | Without an author, every approval stays unclassified/high (owner-only). | ADI sets it from its risk profiles and the business's policy; a human may raise it, never lower it, before publication. |
| Q2 | **Class vocabulary.** The locked spec says "risk" but defines no classes. `low/medium/high/critical` is the P0-2 implementation vocabulary (reconciliation ruling L-1). | A locked vocabulary needs an explicit amendment; an implementation vocabulary does not. | Keep it as an implementation vocabulary documented in a build spec, not the locked spec, unless you want it locked. |
| Q3 | **Definition of "materially stale".** §11 gives one example (Twin state changed after recommendation). | "Any newer published snapshot" is the simplest and strictest; "material change" needs thresholds I must not invent. | Use the strict rule now (newer published snapshot ⇒ stale); thresholds only by your ruling. |
| Q4 | **Override policy (§12).** "Unless policy allows an explicit manual override." | Needs a policy, roles and an audit trail. | No override in P0-3; revisit after P0-4 audit events exist. |
| Q5 | **Time-sensitive marker.** Which recommendations *must* have `valid_until`? | Spec says "time-sensitive" without a definition. | Treat high/critical risk and anything with an expiring input as time-sensitive; low risk may omit it. Needs your confirmation. |
| Q6 | **Soft vs FK for `twin_snapshot_id`.** ABA→DT FK would add a cross-layer dependency. | Layer ownership. | Soft reference (uuid) validated in the service, no FK. |

No locked-spec conflict was found in §§4, 7, 8, 11, 12: the proposal places each fact with its spec-named owner. Q1, Q3 and Q5 are decisions the spec leaves open; I will not guess them.

## 6. Implementation plan after your answers (one block each)
1. Migration(s) (ADI columns, ABA columns) + repository fields + migration/RLS tests on live Postgres.
2. Authoring path in ADI + snapshot copy in ABA review creation.
3. Enforcement in `submitApprovalDecision` (expired/stale/risk) + tests (expired blocked, stale blocked, reject allowed, valid approved, unclassified high, API cannot set risk).
4. Docs and handoff; P0-4 (audit of approve/deny/expire) follows.


---

## 7. Owner rulings (2026-10-07) and Block 1 status

Rulings applied: Q1 ADI authors `risk_class` (human may raise before publication, never lower informally; ABA snapshots, never recalculates); Q2 `low|medium|high|critical` is an implementation vocabulary, unknown/missing stays fail-closed (P0-2); Q3 strict staleness (a newer **published** Twin snapshot for the same business; drafts do not count; approve and approve-with-modifications blocked, reject allowed, recovery = RECALCULATE DECISION; no thresholds); Q4 no override, `approval_exceptions` not activated; Q5 explicit `is_time_sensitive` fact (risk does not imply it), `valid_until` required when time-sensitive and enforced whenever present, unknown never silently false; Q6 soft UUID `twin_snapshot_id`, no ABA->BDT foreign key; Q7 BUILD-33 (#22) first.

**Migration allocation (rule: inspect, then record).** PR #22 merged (`22356dd`), so 0172 and 0173 are on `main`; open migration-bearing PRs: none. This build allocates **0174** (ADI) and **0175** (ABA). Frozen predecessor range 0001-0173 untouched.

### Block 1 (this change): persistence only
- `0174_add_adi_recommendation_risk_validity.sql`: adds `risk_class`, `is_time_sensitive`, `valid_until`, `twin_snapshot_id` (all nullable) to `ai_decision_intelligence.decision_recommendation_versions`; CHECKs for the class vocabulary and for `is_time_sensitive IS NOT TRUE OR valid_until IS NOT NULL`; trigger making the four facts immutable once published and `risk_class` raise-only (never lowered or cleared).
- `0175_add_aba_review_version_snapshot.sql`: adds `source_recommendation_version_id` (FK to the ADI version, RESTRICT), `risk_class`, `is_time_sensitive`, `valid_until`, `twin_snapshot_id` to `approved_business_action.action_review_package_versions` (append-only table, so the snapshot cannot change). No time-sensitivity CHECK on purpose: ABA must record what it received and block at approval.
- Repositories: ADI `createRecommendation(..., riskValidity?)` with `normalizeRiskValidity` validation and the four fields on the version model; ABA `createVersion(..., snapshot?)` and `getLatestVersion`. Nothing derives or enforces yet.
- Tests: ADI (8) and ABA (4) live-PostgreSQL cases covering defaults (NULL, never low or false), round trip, validation, DB checks, raise-only, published immutability, append-only snapshot, lineage FK, tenant isolation. Mutation-proven: dropping the integrity trigger fails 2, dropping the time-sensitive CHECK fails 3.

Legacy rows keep NULLs (unclassified / unknown); no value is fabricated. Consumers (Block 3) treat NULL risk as high and NULL time-sensitivity as unknown, not false.

### Remaining blocks
2 ADI authoring (derive risk_class from persisted risk profiles and policy, explicit is_time_sensitive, valid_until derivation, twin reference, ABA snapshot copy at review creation); 3 server-side approval enforcement (stale / expired / unclassified / time-sensitive-missing-validity, reject allowed, caller cannot inject trusted state; replaces the trusted-caller `riskClass` parameter from P0-2); 4 docs and handoff, then P0-4.


### Block 2 (this change): ADI authoring and ABA snapshot copy
- `packages/workflow/src/recommendationAuthoring.ts` (pure): `deriveRiskClass` takes the HIGHEST of the authored level and any persisted risk-profile severities (Q1: never lowered by another input); an input outside the vocabulary makes the result **unclassified (null)** rather than being ignored (Q2). `determineTimeValidity` produces the explicit time-sensitivity fact (Q5): true with `valid_until` = the earliest authoritative end date when any signal exists (evidence expiry, forecast/simulation horizon, action window, other authoritative period); a policy marking without any end date is an **error** (a time-sensitive recommendation must carry `valid_until`); false only when every signal source was evaluated and none applies; **unknown (null)** when a source was not evaluated.
- `BusinessDecisionRecommendationService.recommend` now authors the facts: risk class from the generator's `risk_level` (the only risk evidence this flow has), `is_time_sensitive` via `determineTimeValidity`, and `twin_snapshot_id` = the published Twin snapshot it used (`TwinComputationService.getOrComputeTwin` now also returns `snapshotId`, additive). The derivation is persisted as an append-only `risk_validity_basis` rationale row.
- `ActionReviewRepository.resolvePublishedSnapshot` reads the facts of the PUBLISHED recommendation version behind an intake package (intake -> ADI publication -> insight version -> recommendation version); `DecisionWorkflowService.createReview` copies them onto the review version. ABA does not derive or recalculate. A broken chain or an unpublished recommendation gives an all-null snapshot (unclassified / unknown).
- Still no enforcement (Block 3), no override, no ABA->BO wiring.

**Limitations to carry into Block 3 / for owner attention**
1. For twin-grounded recommendations no data source exists yet for evidence expiry, forecast horizon, action window or a policy time-sensitivity marker, so every source evaluates to "none applies" and `is_time_sensitive` is authored `false` with that basis recorded. Staleness (Q3) is the temporal guard for these. If you want a different rule for "no source exists", that is an owner decision.
2. The generator's `risk_level` is model output (LLM or deterministic rules). A model that under-labels risk produces a lower class than a human would; humans can raise it before publication but nothing lowers it. A policy-defined floor would need an explicit policy decision; none was invented.
3. The twin flow's recommendations have no persisted alternative risk profiles, so `persistedSeverities` is not used there; the function supports it for flows that create alternatives.

### Block 2b (owner rulings of 2026-10-07, after Block 2 merged): authoritative risk floor and complete-evaluation rule
Supersedes the two Block 2 limitations above.
- **Time-sensitivity (Q1):** `is_time_sensitive = false` is an authored conclusion, persisted only after every defined authoritative source (evidence expiry, forecast/simulation horizon, action window, decision-policy marking, other authoritative period) was successfully evaluated and none applies. Evaluation that is incomplete, unavailable or throws leaves it **NULL/unknown**, never false (`ValiditySignalEvaluator`, `evaluationError`). Block 3 will treat NULL as BLOCK for approval until recalculated, TRUE without `valid_until` as BLOCK, FALSE without `valid_until` as allowed, and any present `valid_until` as always enforced.
- **Risk class (Q2):** `risk_class = MAX(deterministic persisted floor, validated generator risk_level, authorised human upward adjustment)`. The floor is the highest severity in `alternative_risk_profiles` for the chosen alternative; it is enforced **in the database layer** (`createRecommendation` takes the maximum of the proposal and the floor), so model output can never lower it. Invalid or missing model output is ignored when a floor exists; with no deterministic evidence and no valid model output the recommendation stays **unclassified** and P0-2 treats it as HIGH. `raiseRiskClass` is the only human path: raise-only, pre-publication only (database trigger), no downgrade path. No numeric scoring policy was introduced.
- ABA still only copies the persisted ADI-authored values (tested, including a human raise before publication).

### Block 3: server-side approval enforcement
`DecisionWorkflowService.submitApprovalDecision` now judges an approving outcome (`approve`, `approve_with_modifications`) from **persisted** facts only: the latest ABA review version (ADI-authored values snapshotted by ABA), the database clock, and a read-only Digital Twin freshness assessment. `reject` is never gated by facts (it still needs active approver authority).
- Risk: `riskClass` is read from the review version (NULL = unclassified, treated as high by P0-2). The trusted-caller `riskClass` input added in P0-2 is **removed**; the API, the body and any caller can no longer supply risk or validity facts (forged fields are ignored; tested through HTTP and the service).
- Gate (`packages/workflow/src/approvalGate.ts`, pure), each failure is `ApprovalBlockedError` (HTTP 409, recovery `RECALCULATE_DECISION`):
  - `valid_until` present and <= database `now()` -> `EXPIRED`, regardless of `is_time_sensitive` (boundary inclusive; an invalid date also blocks).
  - `is_time_sensitive` NULL -> `TIME_SENSITIVITY_UNKNOWN` (never read as false); TRUE without `valid_until` -> `TIME_SENSITIVE_WITHOUT_VALIDITY`; FALSE without `valid_until` -> allowed.
  - A newer **published** Twin snapshot for the same business (effective after the snapshot used) -> `STALE`; drafts / unpublished / rejected snapshots do not count. A present `twin_snapshot_id` that cannot be verified (unknown, another business, never published) -> `TWIN_SNAPSHOT_UNVERIFIABLE` (blocked, not assumed fresh). No `twin_snapshot_id` -> nothing to compare, staleness is not asserted.
  - No review version at all -> `REVIEW_FACTS_MISSING`.
- `DigitalTwinSnapshotRepository.assessFreshness` is read-only; ABA does not mutate or own Twin state, and no ABA->BDT foreign key exists.
- No override: `approval_exceptions` is not used. No ABA->BO wiring.

**Behaviour changes to note**
1. Reviews whose recommendation has NULL `is_time_sensitive` (all pre-0174 data, and any flow that has not authored it) can no longer be approved until the decision is recalculated. This is the owner's ruling; the twin-grounded flow authors an explicit value after a complete evaluation.
2. A recommendation becomes stale as soon as the business publishes a newer Twin snapshot (the Twin refresh route, or a recompute after the 1 hour cache), per the strict rule; the user must recalculate.
3. Tests that previously approved with a trusted `riskClass` now create recommendations with persisted facts instead.
