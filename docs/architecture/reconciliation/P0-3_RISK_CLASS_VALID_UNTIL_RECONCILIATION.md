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
