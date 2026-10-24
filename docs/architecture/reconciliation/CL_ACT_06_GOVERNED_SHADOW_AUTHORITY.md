# CL-ACT-06 — Governed Shadow Audit and Operator Authority (preparatory)

Baseline: main c4ae353a4aa99998a7fbe8adf0c61244a0ea2ebe (PR #290 merged).

## Delivered
Pure `assessShadowOperatorProposal` validation for versioned, scoped shadow operator decision proposals. It checks UUID scope and principal IDs, separation of operator and approver, explicit proposed `cl:shadow:evaluate` permission, positive control/authority versions, active/non-revoked state and canonical UTC expiry. It produces frozen refusal reason codes and **never** grants evaluation, learning release or mutation privileges. No production composer uses this module.

## Crucial limitation
This function reviews *caller-supplied claims*, not canonically authenticated identity. `acceptedForReview` is not `authorized`; it is intentionally unusable as a production authorization decision. The permission code is a proposed policy label only, not an IAM/RBAC grant. The caller-supplied `evaluatedAt` is not trustworthy database time. Do not wire this evaluator to a live endpoint or operational flag.

## Required audit authority for a future owner-approved block
Before introducing any live operator functionality, owner/security review must approve:
1. Canonical principal authentication and a versioned tenant/workspace/business-scoped permission assignment read from the authoritative identity/ABA source, rechecked at request time.
2. Separation of operator and independent approver; revocation and expiry evaluated using database time, not caller time. Kill switch outranks both.
3. Append-only, database-enforced audit record bound to tenant/workspace/business, actor, approver/assignment versions, control version, decision, reason codes, immutable source digest, database timestamp, supersession and idempotency key. Immutable payload and canonical hash format require version approval.
4. Durable transactionality of control-decision and audit append, exactly-once/idempotent replay semantics, privileged-service access and RLS denial of cross-tenant updates.
5. Operator revocation and negative-case/forgery tests in a disposable PostgreSQL instance before any production use.

No database schema, migration, authenticated operator adapter, audit writer or feature flag is introduced here. Do not mistake the pure validation tests for durable audit or authority acceptance. M1–M3, O1, A1, P1 and CL live activation remain unresolved/disabled.

## Verification
Code and tests committed. Full unit tests, typecheck and CI not independently verified at authoring. Keep draft until validated.
