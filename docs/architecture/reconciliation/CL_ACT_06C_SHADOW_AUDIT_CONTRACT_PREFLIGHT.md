# CL-ACT-06C — Shadow audit contract preflight, implementation gate

**Status: partial preparatory implementation, NOT owner-approved audit persistence.**

Baseline: main `c562b05b6eb8b436bee92840084886f78a889646` (PR #292).

## Implemented

An isolated `cl-shadow-audit/1` candidate contract, with pure structural preflight and negative tests. It checks scoped UUIDs, canonical digest format, event type, idempotency key, version, bounded reason codes, separation of operator and approver, and the required approval lineage identifiers. All results explicitly state `authorityGranted:false` and `auditPersisted:false`.

This is **not** an authenticated audit writer and **does not** demonstrate database immutability. Input is untrusted and any `acceptedForSchemaReview` result is a design signal only, not permission.

## Explicit owner policy decisions still unresolved

1. Select the canonical permission issuing authority; specify exactly who can grant/revoke `cl:shadow:evaluate` and independent approver policy.
2. Approve audit data-domain ownership and migration design, retention and canonical event/digest encoding.
3. Specify control revocation and supersession semantics, idempotency scope and concurrency transaction ownership.
4. Specify custody of the kill switch, emergency shutdown and observability.

A broad request to implement this block is not a substitute for these concrete settings. No existing ABA approver assignment or `bo:admin` role can silently grant the new CL shadow permission.

## Next block after owner rulings

Prepare a uniquely allocated migration under the canonical database-owner workstream. Implement forced tenant/workspace/business RLS, composite-scope references, narrowly scoped insert rights, database-issued timestamps and append-only UPDATE/DELETE/TRUNCATE prevention; never a second ABA authority ledger. Add the trusted authority adapter with current canonical identity, database-time revocation check and atomic append + control decision. Rehearse all of it in a **disposable migrated PostgreSQL** instance with separate application/admin roles, including concurrency, immutable row integrity, cross-scope denial, replay, kill switch and denied production-learning mutations.

**No migration selected or applied, no production database touched, no tests claimed executed, no permission granted, no production Continuous Learning activation.**
