# CL-ACT-06R — Trusted Identity / ABA Authorization Adapter Specification

**Status: REVIEW-ONLY TRUST BOUNDARY — NO ADAPTER ENABLED.** Base main `c8b5df548cae67318af46e22a97e8b11360f8818`. CL-ACT-06Q source/test contract moved from conflicted #309 to replacement draft PR #310. This block must not depend on merging #310 without successful CI.

## Canonical implementation evidence

- Database `packages/database/src/client.ts` has `TenantContext` with `tenantId`, `workspaceId`, `userId`; `withTenantTransaction` sets transaction-local `app.tenant_id`, `app.workspace_id`, `app.user_id`. **No businessId context or authenticated-session proof** exists in this helper. A caller-provided context cannot establish identity.
- ABA `ApproverAuthorityRepository.ts` owns `approver_assignments`, versions and scopes with tenant/workspace/business IDs; `findActiveForUser(ctx,businessId,userId,assignmentCode)` is read-only, but assignment-code matching alone cannot grant a new CL permission. No direct CL authorization should be inferred.
- Migration `0095_create_aba_approvers_authority.sql` contains individual scope references, not a composite FK proving matching tenant/workspace/business across assignment and version.
- CL-ACT-06Q proposal defines `CanonicalShadowPrincipal` and `AbaShadowPermissionEvidence` with an advisory `reviewShadowBusinessScope`. **Claimed booleans are untrusted** and always result in `operatorAuthorized:false`.

## Proposed trusted adapter (requires identity/ABA owners' approval)

1. **Session verification:** The canonical identity/session owner validates session/token signature, expiry, revocation and required authentication assurance. Derive `userId`, tenant/workspace from server-verified claims/membership; never take these from a request body or SQL `app.user_id` alone.
2. **Business membership:** Read authoritative business ownership/membership relationship under the verified principal and exact tenant/workspace/business scope. Require active membership and fail on duplicates or cross-scope references. A trusted session still does not by itself grant CL privileges.
3. **ABA read port:** Identity/ABA domain exposes a dedicated read-only `verifyExplicitShadowPermission` (proposed name) with verified current `cl:shadow:evaluate` grant, unique scoped assignment ID/version, status, permission provenance, independent human approver and no delegation. This is a **new interface specification**, not an existing public API. Don't silently map `bo:admin`, `assignment_code` or arbitrary `role_code` to authorization.
4. **Freshness:** Check against database-clock time; verify grant version and revocation in the same protected transactional operation as a later audit/control append. Do not hold stale adapter evidence across retries.
5. **RLS boundary:** The DB owner must provide reviewed composite scope enforcement and restricted caller/role binding; do not introduce untrusted optional `businessId` into the generic `TenantContext` and assume PostgreSQL RLS will verify it.
6. **Separation:** CL consumes the verified adapter result, never writes ABA assignments. The CL audit writer verifies default-deny kill state and current authority in its own atomic transition. Audit events cannot confer permission.
7. **Failure semantics:** Invalid session, absent/mismatched membership, missing/duplicate/expired/stale grant, delegated or self-approved authority, revocation race, missing kill state, RLS uncertainty and adapter timeout **all refuse**, with bounded reason codes only.
8. **Nonactivation:** Any trusted adapter eventually implemented must remain disconnected from production routes until separate role/grant, migration, disposable PostgreSQL acceptance and live-shadow owner authorization. No OM-to-CL learning release, model, policy or BO mutation.

## Minimum adapter contract to approve

Inputs: server-verified session reference and requested business/control identity. Outputs: immutable scoped verified principal plus current ABA assignment/version/approval evidence and DB-time validity, or explicit refusal; no caller-controlled `verified=true` claims. Contract requires provenance source identifiers, expiry, revocation-version, audit correlation and privacy-safe error codes. Database/security owner must separately approve implementation, roles and protected transaction design.

## Acceptance before any implementation

- Source audit of actual session verifier and business membership repository, including tests.
- ABA issuance/revocation/provenance owner supplies the exact shadow grant format and read port.
- Identity/DB/security review of transaction binding, composite foreign keys, FORCE RLS, and deny-all/least-privilege grant topology.
- Tests for token spoofing, membership mismatch, bo:admin confusion, self-approval, delegation, stale/revoked versions, retries after revocation and parallel-scope isolation.
- Disposable PostgreSQL acceptance and owner approval are separate later gates; **none executed in this specification**.

**No permission grants, SQL migrations, database tests, production auth integration, live Shadow Mode or Continuous Learning activation.**
