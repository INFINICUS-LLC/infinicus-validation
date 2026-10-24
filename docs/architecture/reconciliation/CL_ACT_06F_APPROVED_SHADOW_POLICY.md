# CL-ACT-06F — Owner-approved shadow policy specification

Status: **SEVEN POLICY PRINCIPLES OWNER-APPROVED; MIGRATION AND PRODUCTION STILL BLOCKED.**

The owner explicitly approved the following seven CL-ACT-06E principles on 2026-10-24:

1. The canonical identity/ABA authority owner issues the explicit `cl:shadow:evaluate` permission; no implicit inheritance from `bo:admin`.
2. An independent human approver is required; the operator cannot approve their own request, and delegation is not permitted for the initial rollout.
3. Shadow Mode is default OFF; the emergency kill switch overrides any approval.
4. Continuous Learning owns shadow audit records; ABA retains ownership of approval assignments.
5. No automatic audit deletion until applicable retention requirements have been approved.
6. Revoked or stale authority causes immediate refusal; current authority must be rechecked at evaluation time.
7. All shadow evaluations remain advisory. CL publication, autonomous learning, model and policy updates, and Business Operations mutations are disabled.

Implemented as a **pure immutable policy contract**, `ApprovedShadowPolicy.ts`, and regression tests. No database or permission write path consumes this specification yet. The owner approval is for the specification, not authorization to activate live shadow or migrate production.

## Decisions still required before persistence or migration

- Final retention duration, regional legal deletion and data-minimization policy.
- Canonical serialization and digest algorithm version, protected off-database anchoring and chain recovery.
- Canonical permission service/read port, scoped composite FK/authorization constraints and least-privilege application role grants.
- Idempotency collision handling, concurrent control transitions and atomic audit append semantics.
- Named kill-switch custodian and revocation/incident notification procedure.

## Relationship to PR #296

PR #296 remains an **open** SQL design candidate outside numbered migrations. It must not be promoted unchanged: its candidate SQL does not yet prove assignment composite scope, hash anchoring, or narrow INSERT/RLS policy. Rebase/reconcile only after schema, permissions and retention decisions are finalized.

## Future disposable-DB acceptance

Use disposable PostgreSQL only, under separately scoped owner, app and fixture roles. Test authenticated identity and canonical authority read, independence of approver, deny on revocation, kill switch precedence, cross-tenant/workspace/business denial, append-only INSERT/UPDATE/DELETE/TRUNCATE privileges, concurrent idempotency/atomic rollback, signed/durable digest anchoring, and no CL publication/model/policy/BO mutations. Skipped database tests do not constitute acceptance.

**No migration created, no production deployment, no permission issued, no database/RLS tests executed in this block.**
