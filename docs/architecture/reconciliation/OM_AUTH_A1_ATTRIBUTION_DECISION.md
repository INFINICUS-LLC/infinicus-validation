# OM-AUTH-A1 — revenue attribution authority decision

Status: **owner decision required; PASS closed**. Base: `main` at `3a2b09c` (O1 merged). This block reviews attribution authority only. It does not approve a revenue causal rule, write an assessment, enable a verdict or release learning.

## Existing contract reconciliation

`outcome_attribution_runs` records queued/running/completed/failed work for a legacy observation; factors and results store descriptions, weights and uncertainty. `completed` is a lifecycle state, not an attribution PASS. These tables do not bind an observation **version**, execution verification, rule version, source/confounder digest, assessor identity or a PASS/FAIL/INCONCLUSIVE result. The legacy repository can update a run and add factors/results, so the structure is not an append-only governed assessment. Migration 0214 enforces scope when a governed verdict references a run, but it cannot turn a legacy run into a causal finding.

OM-MEASURE-6's conservative inventory check covers other applied reorder-policy executions and same-item/warehouse adjustments in the baseline/window. It returns INCONCLUSIVE when confounded and `ATTRIBUTION_UNAVAILABLE` when clear. Its rule and BO source set are inventory-specific; they cannot be reused as revenue PASS authority. OM-MEASURE-7's candidate `attribution.status = 'PASS'` is an advisory input and its result always denies verdict authority.

## Revenue source inventory and open rule

BO orders and order-line discount fields can expose some sale/discount facts. Existing order/payment records do not establish immutable completed-sale corrections or authoritative applied refunds, as M1A found. No approved, complete, scoped source inventory was found for promotions, price changes, channel mix, demand shocks, external events, or refund timing. A missing source must be UNKNOWN/INCONCLUSIVE, never interpreted as absence of a confounder. A revenue trend alone is not proof that the monitored action caused it.

The owner must approve:

1. The exact action type and causal claim being evaluated, including whether a revenue outcome is attributable at all under the proposed pilot design.
2. A versioned list of confounder classes and authoritative source references, including pricing, promotions/discounts, channel mix, refunds/reversals, other concurrent actions, demand and external factors; define the business/currency and baseline/window scope for each. Identify any class that cannot currently be observed.
3. An explicit decision rule for PASS, FAIL and INCONCLUSIVE, including how competing actions, missing/truncated records, source corrections, overlap and ambiguous causality are treated. Mere absence of known events cannot silently become PASS.
4. The assessor role and approval authority, its independence from executor, measurement author and final approver, and the audit/provenance record needed at assessment time.
5. Whether governed assessments extend the existing attribution-run ID or use a separate append-only version keyed to that run and the canonical observation/version. Specify monotonic version, supersession, unique replay key, database-issued time and composite tenant/workspace/business foreign keys. A mutable `completed` legacy run remains ineligible by itself.
6. Canonical digests and reread rules binding the exact observation/version, execution verification, definition/rule version, source rows, confounder evaluation and assessor. A changed input invalidates the prior assessment for a new verdict.

## Implementation gate after owner approval

Design the minimal OM-owned append-only assessment binding; do not create an alternative BO event ledger. Test on disposable PostgreSQL: scoped reference and RLS refusal; wrong-role writes; PASS only with complete named sources; unknown source and confounders produce INCONCLUSIVE; replay, changed-source supersession, stale assessment, forged digest/time, and UPDATE/DELETE/TRUNCATE refusal. A1 approval alone cannot permit VERIFIED or FAILED: M1/M2/M3/O1/P1 and a separate positive-verdict schema and runtime review remain required. OM → CL remains closed.

## Completion-matrix evidence delta

| Capability | Evidence | Authority |
| --- | --- | --- |
| Legacy attribution runs/factors | Existing mutable lifecycle and weights | No PASS semantics |
| Inventory negative confounder review | OM-MEASURE-6 | Inventory only; clear read is still inconclusive |
| Governed revenue attribution | No approved causal rule, complete source list or assessor authority | **Closed** |
| Positive verdict and learning | No governed attribution PASS | **Closed** |

No runtime or schema code is changed because these source and causal semantics require the owner's explicit ruling.
