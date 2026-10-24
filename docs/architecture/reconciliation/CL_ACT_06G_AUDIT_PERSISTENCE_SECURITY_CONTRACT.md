# CL-ACT-06G — Audit Persistence Security Contract

Status: **PRE-MIGRATION ACCEPTANCE SPECIFICATION ONLY**. Base main `71bbcb3652947884c75e5432050dc1aadab82aca` (PR #297 merged).

## What is approved

The owner approved seven shadow-governance principles, committed in `ApprovedShadowPolicy.ts`: explicit canonical identity/ABA permission; independent human approval and no delegation; default OFF and kill switch; separate CL audit and ABA assignment ownership; no automatic retention purge; immediate revoked/stale denial; and advisory-only shadow with no model/policy/BO mutations.

## Security acceptance contract

`ShadowAuditSecurityContract.ts` enumerates 15 controls spanning canonical authentication, scoped authority, current assignment, approver separation, database time, kill switch priority, composite scope, FORCE RLS and least privilege, insert-only append history, atomic control/audit transaction, scoped idempotency, versioned digest and protected audit anchor, retention, and mutation prohibition.

`assessShadowAuditSecurityEvidence` is a **pure, deliberately non-authorizing completeness indicator**. It never authorizes schema migration, production shadow, or learning, even if all self-reported controls are marked verified. Its input is not authenticated acceptance evidence. Regression tests lock that behavior.

## Remaining security/schema decisions before a migration

1. **Retention:** specify exact legal basis, jurisdiction, duration, data minimization, DSAR handling, and immutable-audit deletion/exemption policy; cannot default to infinite retention.
2. **Integrity:** specify canonical byte serialization (including nulls, order, encoding and versions), hash domain separation, signed/external anchor custody, key rotation, verification/recovery, and threat model against database owners.
3. **Authorization and scope:** choose exact identity/ABA read port and permission issuance/revocation API; composite scope/assignment FK enforcement, database roles, RLS claims, and a guarded insert function.
4. **Transactions:** allocate scoped idempotency uniqueness, locking and retry behavior; audit append and state change must commit or roll back atomically.
5. **Custody:** name incident responders authorized to set/reset the kill switch; specify emergency revocation path, audit event ordering, and independence from the operator.

## Relationship to PR #296

PR #296 is an **open** draft SQL candidate, not an applied migration. It must not be promoted unchanged: its proposed FK checks and RLS/policy/privilege matrix are incomplete, its hash is caller-supplied, and it does not yet establish authenticated write authority or anchored evidence.

## Later acceptance

Only after exact owner/security/schema decisions: implement a reviewed numbered migration and canonical authorization adapter, then test on a **disposable migrated PostgreSQL** instance using separate owner/admin/app roles. Prove cross-tenant denial, valid and revoked ABA permissions, independent approver, immutable UPDATE/DELETE/TRUNCATE denial, atomicity, concurrent idempotency, digest anchors, kill switch, and zero OM→CL learning release/model/policy/BO mutations. Capture actual test run, database version, privileges, CI, and negative-case evidence. Skipped tests are not acceptance.

**No database migration created/applied, no PostgreSQL test executed, no new IAM grant, no production shadow activation or CL learning.** Keep draft PR pending green CI and owner approval of exact schema controls.
