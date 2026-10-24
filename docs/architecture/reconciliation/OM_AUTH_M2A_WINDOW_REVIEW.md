# OM-AUTH-M2A — baseline and window completeness review

Status: **read-only preparatory inspection; no measurement or verdict authority**. Base: `main` at `9bfa614` (M1A merged). This review uses the proposed M2 pilot shape only as caller-supplied bounds; it does not approve seven days, minimum observations, a calculation, or a success criterion.

## Architecture and authorization reconciliation

`SalesWindowEvidenceReviewRepository` reads existing `business_operations.order_events(completed)` and `platform.orders` under the tenant transaction with explicit tenant, workspace and business predicates. It examines half-open UTC baseline and observation periods, checks contiguous equal durations and execution alignment, counts completion transitions, and detects duplicate orders, invalid lifecycle or timestamp ordering, currency/amount problems, an open observation window and truncated evidence. It returns a digest of the inspected completion rows so a later source change can be seen. This digest is an inspection aid, not an immutable provenance guarantee.

The response type is always `authoritative: false`. Every database result reports `SOURCE_MUTABLE` and `REFUND_SOURCE_UNAVAILABLE`. Completion events can be changed, and the current BO credit-note source cannot prove applied refunds, reversals, or refund application time. A zero count is flagged as empty evidence, not interpreted as zero revenue. No BO writer, second sales ledger, OM observation, attribution PASS, positive verdict, permission, migration, deployment, or CL gate is introduced.

M1A's completion and refund source decisions remain pending. M2 also needs owner approval of the window duration, equivalence and sufficiency rule, handling of empty or sparse periods, and source completeness criteria. M3 threshold and direction, O1 writer/version/provenance, A1 revenue attribution, and P1 human approver authority remain unapproved. The existing OM-MEASURE-7 refusal path and OM → CL gate remain controlling.

## Verification

- Database package typecheck: passed.
- Focused unit and synthetic integration suite: five passed against disposable PostgreSQL 16 with repository migrations and tenant role grants. Cases cover malformed and invalid UTC bounds, period/execution mismatch, unsupported currency, half-open completion-time boundaries, duplicate completion, cross-currency sale, invalid completion ordering, changed source digest, tenant/workspace/business isolation, and an open future window.
- The test's event update is deliberate evidence that the existing source remains mutable. It does not authorize that mutation in production.

## Completion-matrix evidence delta

| Capability | Evidence | Authority |
| --- | --- | --- |
| Scoped baseline/window inspection | M2A reader and disposable PostgreSQL tests | Read-only, always nonauthoritative |
| Governed net-sales revenue | Completion source mutable; applied-refund source incomplete | Blocked by M1 owner decision and BO implementation |
| Approved M2 sufficiency and seven-day rule | Proposal only | Unapproved |
| OM positive verdict and CL learning | No new path | Closed |

Next independent block: continue read-only M3 criterion/threshold contract review or BO source-authority design after the owner settles M1/M2. Do not implement positive OM verdicts from this review.
