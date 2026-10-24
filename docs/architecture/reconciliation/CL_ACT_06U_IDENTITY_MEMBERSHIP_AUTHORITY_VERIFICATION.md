# CL-ACT-06U — Canonical Identity & Business Membership Authority Verification

**Date:** 2026-10-24. **Result:** SOURCE-CODE AUTHORITY VERIFIED WITH RESTRICTIONS; TRUSTED CL ADAPTER NOT AUTHORIZED. **No migration, grants, live execution or CL activation.**

**Main baseline:** `c8b5df548cae67318af46e22a97e8b11360f8818`. PRs #310–#313 were open at this verification; no reliance on unmerged code. No PostgreSQL/CI test executed.

## Verified canonical identity path

1. `apps/api/src/plugins/auth.ts`: Fastify `authenticate` requires Bearer header and sets `request.session` from `AuthenticationService.validateSession(token)`. Missing header raises SessionInvalidError.
2. `packages/authentication/src/AuthenticationService.ts`: `validateSession` hashes the supplied raw session token, loads `identity.sessions` by hash, refuses missing/revoked/expired session, loads associated user and refuses any user status other than `active`. `revokeSession` and `revokeAllUserSessions` exist. This is an authenticated **user** session, not permission or tenant proof.
3. `packages/database/src/repositories/auth/SessionRepository.ts`: session rows have user, expiresAt, revokedAt and token hash. No tenant context is stored or RLS enforced on sessions; tenant/workspace must be verified separately.

## Verified canonical tenant/workspace membership path

1. `apps/api/src/plugins/tenantContext.ts`: `resolveTenantContext` refuses missing `request.session`; reads client-supplied `X-Tenant-Id` and `X-Workspace-Id`, then calls `MembershipRepository.getByUserAndWorkspace({tenantId,workspaceId,userId},userId)` with the authenticated session user ID; refuses non-active membership; sets `request.ctx`. **The header IDs are selectors, not trusted membership assertions**.
2. `packages/database/src/repositories/auth/MembershipRepository.ts`: `getByUserAndWorkspace` runs in a tenant/workspace transaction and reads `tenancy.memberships`; provides `status`. `listActiveForUser` explicitly warns that its caller-supplied userId is not independently authenticated by its DB `app.user_id` setting; it grants no business permission.
3. `packages/database/src/client.ts`: tenant transaction GUCs carry tenant, workspace and user, **not business**; setting GUCs alone does not establish identity authenticity. Need tested RLS and composite scope integrity.

## Verified business ownership evidence — do not conflate with CL authority

- `packages/database/src/repositories/ownership/OwnershipEvidenceRepository.ts`: `loadOwnershipEvidenceWith` reads business state, onboarding link, linked membership/owner-role, business-scoped owners, tenant-wide candidate owners, and existing ABA assignment under tenant-scoped transactions.
- `packages/database/src/repositories/ownership/classifyOwnership.ts`: `provenOwnersOf` and `classifyOwnership` accept as proven only a consistent active onboarding owner membership with owner role **or** active owner membership explicitly linked to the business; tenant-wide owner role alone is only a candidate, never automatically granted. Inactive or deleted business and ambiguous owner cases fail grant eligibility.
- This classifier establishes **business ownership**, not general membership permission and not `cl:shadow:evaluate`. **Do not call `eligibleForGrant` or `PROVEN` a CL authorization grant.** Business-scoped nonowner access has no resolved canonical CL eligibility rule yet.
- `packages/database/src/repositories/approved_action/ApproverAuthorityRepository.ts` owns ABA assignments/versions/scopes. Existing assignment code/role and owner authorization do not imply the new explicit CL grant; ABA must define its own CL issuer/read/revoke contract and independent human approval evidence.

## Security acceptance matrix — exact negative cases required

| Gate | Case | Required outcome |
| --- | --- | --- |
| U-ID-01 | Missing/bad bearer, missing token hash | Refuse; no request.session |
| U-ID-02 | Revoked/expired session, non-active user | Refuse; no tenant or CL scope |
| U-MEM-01 | Missing tenant/workspace headers or no authenticated session | Refuse |
| U-MEM-02 | Inactive/absent membership or wrong tenant/workspace selector | Refuse |
| U-MEM-03 | Valid member but unproven requested business link | Refuse CL scope, not inferred from workspace role |
| U-OWN-01 | Tenant-wide owner only, inactive business, ambiguous owners, broken onboarding owner link | Never infer CL grant |
| U-ABA-01 | No explicit `cl:shadow:evaluate`, inherited `bo:admin`, stale or revoked version, delegated/self approval | Refuse |
| U-DB-01 | Caller-supplied IDs/GUC impersonation, cross-business relation mismatch | Refuse via authenticated binding + composite schema/RLS once separately authorized |
| U-RACE-01 | Session/membership/ABA grant revoked between initial check and append | Recheck current authority inside protected transaction; refuse and roll back |
| U-KILL-01 | Kill switch active, unavailable, or unverifiable | Refuse even with otherwise valid credentials |

## Implementation gate decision

**Verified source locations and code behavior: PASS (static review).** **Trusted CL adapter implementation: BLOCKED** pending identity/ABA/DB/security approvals for a business-specific membership rule, explicit CL permission format, fresh ABA read/version and independent approver, authenticated trusted business context, composite relational/RLS enforcement, and kill switch. Do not blindly promote existing ownership proof to grant authority.

**No runtime tests have been executed for this block.** PRs #310–#313 require reconciliation/CI. Do not treat this document as permission to wire live endpoints, add database roles/grants, execute migrations or activate Continuous Learning. Maintain the seven owner-approved governance rules and all five owner-approved design-only H-policies.
