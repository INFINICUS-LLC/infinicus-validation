# OM outcome authority contracts — owner review draft

Status: **PROPOSED; NO VERDICT AUTHORITY.** This document prepares four contracts requested after OM-MEASURE-7. It does not approve a metric, change a frozen contract, grant a permission, enable `OUTCOME_OBSERVED` / `OUTCOME_VERIFIED` / `OUTCOME_FAILED`, or release anything to CL. The OM-MEASURE-7 refusal preflight and current PENDING/INCONCLUSIVE database constraint remain controlling.

## 1. Measurement contract — `NET_SALES_REVENUE_V1` candidate

**Identity and scope.** A definition is immutable and versioned by tenant, workspace, business, metric code, currency, action type/version, baseline/window bounds, calculation version, attribution rule version, and criterion version. It must be approved before use. Values are exact decimal amounts in one ISO 4217 currency; no cross-currency conversion or floating-point calculation.

**Proposed calculation.** For a half-open UTC interval `[start, end)`, sum each uniquely identified qualifying completed order once at its authoritative completion time, then subtract each uniquely identified qualifying applied refund once at its authoritative application time. A refund must have a proven link to the original order, the same business and currency, and a bounded amount. Draft/cancelled credits, planned/failed/reversed orders, unlinked credits, duplicate source IDs, and ambiguous status histories make the window **incomplete**; they are never silently valued at zero. Preserve source IDs, timestamps, amounts, status/version, and a canonical SHA-256 digest. A later source correction invalidates the observation until remeasured.

**Baseline/window.** Proposed pilot window is seven 24-hour days beginning at the confirmed execution timestamp, with a preceding seven-day baseline ending at that same instant. Both use UTC and the same metric version, currency, inclusion rules and source completeness checks. Completion is checked against database time. This is a proposal, not an approved default.

**Criterion.** No success threshold or direction is approved. The owner must specify a versioned monetary or percentage comparison, treatment of zero/negative baseline, and minimum observations. No code may interpret any increase as success by default.

**Current source gap.** `platform.orders` has `order_date` (date), but no immutable completion timestamp. `business_operations.credit_notes` has an optional invoice link, no proven order link and no authoritative applied timestamp. `FinancialFactsRepository` explicitly omits credit notes from revenue to avoid double counting. Its completed-order totals are **gross operational facts**, not `NET_SALES_REVENUE_V1`. A BO-owned, immutable completion/refund event source with reliable order linkage is prerequisite; BI may calculate from those BO facts, but OM must not create a second sales ledger.

## 2. Machine observation contract

Only an OM service identity may create a governed observation after reading the approved definition and the BO source through a scoped read port. Its immutable identity and monotonic version must bind execution verification ID and digest, definition ID/version, tenant/workspace/business, metric/currency, baseline and window bounds, exact baseline and measured values, source references and canonical input digest, calculation version, service identity and database-issued timestamp. Replays with identical inputs return the same record; changed inputs create a new version and leave prior versions intact. A new version must state which prior version it supersedes. Cross-scope references and client-supplied digests/timestamps are refused.

Before issuing a verdict, OM re-reads source references and recomputes the digest. Missing, changed, truncated or ambiguous evidence remains INCONCLUSIVE. A caller-supplied observation ID, user-entered legacy observation, or an OM-MEASURE-7 advisory preflight result is never machine authority.

**Storage decision needed.** Existing `outcome_observations` and `outcome_observation_versions` serve the legacy workflow and do not themselves prove this machine writer, source digest or execution lineage. The owner must approve how governed records bind to these existing IDs without a second source of truth before a migration or writer is built.

## 3. Attribution assessment contract

One append-only, scoped assessment version binds the observation/version, execution verification, definition/rule version, baseline/window, source and confounder digests, assessor identity, database-issued time and explicit `PASS`, `FAIL`, or `INCONCLUSIVE`. It records every considered confounder with source references and reason. A later assessment supersedes by reference, never update. A missing, truncated, stale, changed or out-of-scope source, unknown confounder class, or incomplete evaluation is INCONCLUSIVE. Only a current PASS for the exact observation/version and rule can support a positive verdict; verification re-reads its inputs.

OM-MEASURE-6 currently provides conservative read-only confounder detection for *inventory reorder policy changes* and deliberately does not persist attribution. Legacy `outcome_attribution_runs` have queued/running/completed/failed lifecycle states and weights, but no authoritative PASS, assessor, rule version or source digest. They cannot be relabelled as a passing assessment. **Revenue attribution rule and source inventory are unapproved.** The owner must define which pricing, promotions, channel, refund, demand and other changes are confounders, their evidence sources, and whether any absence-of-confounder test can support causality for this metric.

## 4. Human approver authority contract

A positive verdict requires a named, active human whose tenant/workspace/business authority is rechecked at the decision time from canonical ABA assignment/version and authority provenance, with an approved outcome-verification permission or explicitly approved reuse of an existing permission. Record the authority proof reference and decision audit event. The approver must differ from the action executor, measurement definition author, OM runner and attribution assessor; an unknown actor ID fails closed. Revoked, expired, delegated-without-proof, cross-business, self-approved or stale authority refuses without a verdict. No `AUTO` approval in the first rollout.

Existing ABA `approver_assignments`, assignment versions and `approval_authority_scopes` provide scoped approval lineage. They do **not** by themselves grant outcome-verification authority, and this draft grants none. The owner must choose and approve the permission mapping and any delegation policy before implementation. `bo:admin` is not silently treated as outcome-verification permission.

## Decisions required for approval

| ID | Owner decision | Current proposal/default |
| --- | --- | --- |
| M1 | Qualifying sales/refunds, event timestamps, order-refund link and correction source | Require immutable BO evidence; **blocked by current schema** |
| M2 | Seven-day UTC baseline/window and sufficiency count | Proposed only; no default |
| M3 | Success direction, threshold, zero/negative baseline treatment | **Unspecified; fail closed** |
| O1 | Governed observation writer identity, storage/link to legacy IDs, supersession and digest format | **Unspecified; fail closed** |
| A1 | Revenue confounder rule, source list, assessor authority and PASS semantics | **Unspecified; fail closed** |
| P1 | Existing permission reuse or new approved permission, delegation and audit mapping | **Unspecified; fail closed** |

**Approval rule.** Approval must identify these decisions and their versions. Approval of the direction alone does not activate a positive verdict. After approval, implementation still requires a separate code/migration review, disposable PostgreSQL proofs for tenant isolation, append-only integrity, writer/approver role separation and idempotency, and an OM→CL rehearsal. Learning activation remains a separate owner decision.
