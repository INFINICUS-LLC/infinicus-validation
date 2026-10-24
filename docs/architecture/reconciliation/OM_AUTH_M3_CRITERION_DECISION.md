# OM-AUTH-M3 — revenue criterion authority decision

Status: **owner decision required; no criterion execution authority**. Baseline: `main` at `72cccce`. This is an independent review; OM-AUTH-M2A is still on its separate branch.

## Reconciliation

The proposed `NET_SALES_REVENUE_V1` contract calls for an approved, versioned comparison of exact same-business, same-currency net sales in equivalent periods. It deliberately leaves direction, threshold, zero/negative baseline treatment and minimum observations undecided. M1 completion/refund authority and M2 completeness are also unresolved.

`outcome_monitoring.governed_measurement_definitions` currently stores `success_direction` (`increase`/`decrease`) and a bare `success_threshold numeric`, plus window and minimum-observation counts. It does **not** bind a currency, threshold unit (minor currency units versus ratio), comparison formula, equality rule, treatment of zero or negative baseline, source calculation version or separately identified criterion version. The existing `GovernedMeasurementRunner` understands only `inventory_issue_count`, and stops at PENDING/INCONCLUSIVE. `assessVerificationRefusal` accepts a caller-supplied `criterionApproved` boolean but always returns `verdictAllowed: false`. Migration 0215 constrains persisted governed assessments to PENDING/INCONCLUSIVE and null measurement values. These controls do not grant a revenue criterion.

A numeric threshold row cannot safely be interpreted as a monetary or percentage target. Reusing it for `NET_SALES_REVENUE_V1` without additional approved semantics would create an authority conflict. No schema, runtime comparison, verdict writer or existing definition row is changed in M3.

## Exact owner decision requested

Approve a criterion **version** for a named metric calculation version and one business/currency scope, including:

1. Comparison basis: absolute difference in integer minor units, percentage/ratio change, or another fully specified formula. State whether equality meets the threshold and whether improvement is increase or decrease.
2. Exact threshold representation and range, including currency exponent when monetary. Avoid binary floating-point comparisons; define rounding if a ratio is chosen.
3. Treatment of zero and negative baseline, refunds exceeding sales, negative measured revenue, and equal baseline/measurement values. An undefined case must yield INCONCLUSIVE.
4. Required minimum qualifying sales/refunds or observations for **both** periods, plus the meaning of an empty period. This must agree with the M2 sufficiency rule.
5. Which action type/version this revenue criterion may evaluate, how approval is recorded, who can approve or supersede it, and the effective-time/version rule. A later version must not reinterpret an earlier observation.
6. The evidence needed to bind the approved criterion to a governed BO-derived observation and independent attribution PASS. Criterion arithmetic alone cannot issue VERIFIED or FAILED.

Recommended conservative handling until approval: every revenue comparison is INCONCLUSIVE. Do not infer success from positive movement or failure from missing data.

## Dependent implementation gate

After explicit owner approval of M1, M2 and M3, propose the minimal OM-owned versioned criterion storage and scoped read port. Review any change to the frozen definition contract separately. Verify exact arithmetic, boundary/equality cases, zero/negative baselines, currency and tenant isolation, supersession, and refusal of stale or missing approval on disposable PostgreSQL. The positive verdict and OM → CL release require the separate O1, A1 and P1 decisions and remain closed.

## Completion-matrix evidence delta

| Capability | Current evidence | State |
| --- | --- | --- |
| Revenue criterion semantics | Missing unit/formula, currency, zero-baseline and version authority | **Blocked by owner decision** |
| Existing inventory definition and runner | Numeric threshold stored; runner emits only PENDING/INCONCLUSIVE | Preserved; no new authority |
| Positive revenue verdict and CL learning | No approved observation, attribution or approver chain | **Closed** |
