# CL-ACT-06V — Business-Scoped Membership & Explicit ABA Permission Contract

**Status:** CONTRACT AND REGRESSION TESTS ONLY. **No runtime authority.**
**Baseline:** main `c8b5df548cae67318af46e22a97e8b11360f8818`. Upstream PRs #310–#314 open when this block began. Reconcile shared `src/index.ts` after earlier PRs merge to avoid repeating PR #309's conflict.

## Authority separation grounded in code

- `AuthenticationService.validateSession()`: verifies session token hash, expiration/revocation, and active user. It authenticates a user, not a business.
- `tenantContext.ts` uses authenticated user identity and active `MembershipRepository.getByUserAndWorkspace` to establish tenant/workspace context. Client headers are selectors, not evidence.
- `OwnershipEvidenceRepository` and `classifyOwnership` prove strictly business-linked owner relationships, not generic business permissions. Tenant-wide ownership alone is insufficient.
- ABA's `ApproverAuthorityRepository` owns approval assignments, versions and scopes, but no current authority to infer `cl:shadow:evaluate` from `bo:admin`, owner status, or arbitrary assignment labels.
- `TenantContext` lacks a business-scoped trusted database context. Existing RLS/GUCs are not a replacement for verified membership and permission.

## Development contract

`BusinessScopedAbaPermissionContract.ts` deliberately separates (1) claimed scope-specific workspace/business membership facts from (2) explicit ABA shadow grant evidence. Pure `reviewBusinessMembershipAndAbaPermission` validates exact scope/user match, active relationship, exact `cl:shadow:evaluate`, fresh unrevoked grant/version and distinct verified human approver. Input records are **untrusted**, including `businessRelationshipEstablished`, `unexpiredAtDatabaseTime` and `independentHumanApprover` booleans: **even a complete valid review always returns `authorized:false`, `auditWritePermitted:false` and `learningActivated:false`.**

Unit tests cover missing facts, scope/user substitutions, inactive membership, missing business link, inactive business, `bo:admin` confusion, revoked/stale/expired grant, delegated or self-approved authority. Tests committed, not executed.

## Implementation STOP conditions

1. Canonical identity and business membership authorities must define an authenticated **business-specific** relationship verification port; authorization must not be inferred from workspace membership, tenant-wide owner status, or owner bootstrap eligibility.
2. ABA must issue/revoke a genuine explicit CL scoped permission and produce current assignment/version/provenance and independent human-approval evidence; only ABA manages these records.
3. Database/security review must finalize composite tenant/workspace/business FK integrity, trusted principal/role binding, forced RLS, revocation race atomicity and least-privilege writer.
4. Owner/security authorities must bind the kill-switch, audit encryption/anchors and legal retention values; keep shadow default OFF and advisory only.
5. Reconcile #310–#314 as predecessors, execute CI, and separately authorize any disposable PostgreSQL implementation. No numbered migration or runtime route is approved here.

**Architecture guardrail:** preserve identity/ABA and CL ownership, nondelegated approval, default-deny kill switch and no OM-to-CL learning, model/policy change or BO mutation. No DB migration, grants or Continuous Learning activation.
