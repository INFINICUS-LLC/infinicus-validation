# CL-ACT-06E — Owner decision gate and disposable PostgreSQL acceptance

**Status:** Schema candidate prepared, **not approved**, not implemented as a migration, not tested with PostgreSQL. Continuous Learning stays disabled.

## Conservative policy recommendations awaiting explicit owner ratification

| Decision | Recommended default |
|---|---|
| Permission issuance | Canonical identity/ABA authority owner issues `cl:shadow:evaluate` explicitly; no inheritance from `bo:admin` |
| Approval | Independent current human approver, different from operator; no delegation |
| Control | Default OFF; kill switch ON overrides approvals |
| Ownership | CL owns shadow control/audit facts; ABA alone owns assignment authority |
| Retention | No automatic purge until lawful retention and privacy policy approved |
| Hash and integrity | Versioned canonical encoding and an independently protected audit anchor required |
| Revocation | Immediate deny on stale/revoked grants, checked using database time |
| Isolation | Dedicated least-privileged application role, forced RLS, per-business grants |
| Operational scope | Only advisory shadow evaluations; no learning publication, model updates, policy updates or BO mutations |

No listed recommendation is recorded as an owner approval. CL-ACT-06B established the existing ABA authority cannot silently supply the new permission.

## SQL proposal

`CL_ACT_06E_SHADOW_AUDIT_SCHEMA_CANDIDATE.sql` provides a review-only, transaction-rolled-back DDL proposal, including append-only triggers, forced RLS, scope columns, idempotency uniqueness, and permanently false activation/mutation flags. It deliberately creates **no policy or permission grant**. It is **not** located in the numbered migration directory. The draft does not yet establish composite scope/assignment identity, canonical digest calculation, protected anchors or application-role security; these must be reconciled before migration approval.

## Disposable PostgreSQL validation requirements

Once owner policies and DB-owner migration plan are approved, run only against newly provisioned disposable Postgres:

1. Provision distinct DB owner, application and fixture admin identities; install all baseline migrations.
2. Apply the approved migration to the disposable instance and inspect RLS and grants; verify unauthenticated and cross-tenant INSERT/SELECT rejection.
3. Assert UPDATE, DELETE and TRUNCATE denial through app and elevated non-owner roles; separately inspect owner/superuser limits.
4. Prove scoped composite FK and assignment version correctness; revoked/stale authority must fail closed.
5. Prove concurrent idempotency, rollback atomicity and no orphan approval/audit state.
6. Recompute canonical digest from persisted records and external immutable anchor; detect tampering and broken chains.
7. Prove kill switch priority and no CL release, AI/model changes, policy changes, or BO mutations.
8. Save actual command, database version, role matrix, CI links, test counts and negative evidence in an acceptance report. No skipped tests count as evidence.

**Block outcome:** safe DDL design artifact only. No migration created or applied, no privilege granted, no actual database/RLS test executed. Stop before promoting it to implementation until the policies above are explicitly resolved.
