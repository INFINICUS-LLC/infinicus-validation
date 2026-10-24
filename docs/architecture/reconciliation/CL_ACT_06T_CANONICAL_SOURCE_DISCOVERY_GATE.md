# CL-ACT-06T — Canonical Source Discovery & Trusted Adapter Implementation Gate

**Verdict: SOURCES DISCOVERED; ADAPTER IMPLEMENTATION NOT AUTHORIZED.**
Baseline main: `c8b5df548cae67318af46e22a97e8b11360f8818`. Upstream PRs #310 (06Q), #311 (06R), #312 (06S) open at inspection; reconcile after merge. Owner approval of H-RET/H-HASH/H-AUTH/H-TXN/H-KILL is for development specification only; no permissions, migration or Continuous Learning activation.

## Canonical source inventory — verified files

| Requirement | Current source | Established facts | Gap |
| --- | --- | --- | --- |
| Authentication | `infinicus-platform/packages/authentication/src/AuthenticationService.ts` | `AuthenticationService.validateSession(token)` is the service method used by API authentication middleware, with `ValidatedSession { user, session }` | Need pin exact session/user active/revocation checks and production identity-exchange configuration; no direct authority from request-provided values |
| API principal binding | `infinicus-platform/apps/api/src/plugins/auth.ts` | Fastify `authenticate` extracts Bearer token and sets `request.session = await authService.validateSession(token)`; missing token fails closed | Authenticated session is user-scoped; NOT a business-scoped grant and middleware does not itself issue CL authority |
| Session storage | `infinicus-platform/packages/database/src/repositories/auth/SessionRepository.ts` | `identity.sessions` uses token hashes, `expires_at` and `revoked_at`; session has no tenant ID/RLS; tenant context is separate | Avoid deriving tenant or business ownership from session row alone |
| Membership evidence | `infinicus-platform/packages/database/src/repositories/ownership/OwnershipEvidenceRepository.ts` | `loadOwnershipEvidenceWith(client,{tenantId,workspaceId},businessId)` reads business, onboarding membership link, explicit and workspace-wide owner memberships under tenant RLS | Ownership evidence is not a general authorization decision; resolve business status, user identity, role eligibility, duplicates and cross-tenant/workspace consistency from canonical memberships |
| Transaction context | `infinicus-platform/packages/database/src/client.ts` | `withTenantTransaction` establishes transaction-local `app.tenant_id`, `app.workspace_id`, `app.user_id`; shared scope rejects tenant/workspace mismatch | No trusted `businessId` context. GUC values are not cryptographic identity proof |
| ABA approval authority | `infinicus-platform/packages/database/src/repositories/approved_action/ApproverAuthorityRepository.ts` and `infrastructure/database/migrations/0095_create_aba_approvers_authority.sql` | Assignment, version, scope and delegation records are ABA-owned and business-scoped; current code has read methods | No proven explicit `cl:shadow:evaluate` issuance/revocation model, independent nondelegated approver proof and current locked DB-time read port |
| CL safety | `packages/outcome-monitoring-runtime/src/ControlledShadowEvaluation.ts` | Pure offline shadow evaluator takes caller-provided controls, returns no release/mutation privileges | Not a live authenticated writer or trusted emergency switch state |
| Contract prerequisites | #310 06Q, #311 06R, #312 06S | Non-authorizing scope/evidence interfaces and proposed adapter contract | All open at inspection; review/CI/merge before relying on their exports |

## Correct adapter composition — design decision, NOT new authority

1. Reuse the established API `AuthenticationService.validateSession` middleware as the candidate session verification boundary, subject to confirming actual active-session, expiry and managed identity handling. The caller cannot supply a verified userId or tenantId.
2. Obtain requested business scope from a server-verified tenant/workspace membership and authoritative business relationship. `OwnershipEvidenceRepository` supplies ownership facts, not blanket member access or permission; identify the canonical member/role lookup for the requested operator and business and refuse ambiguity.
3. Ask ABA domain for **explicit** `cl:shadow:evaluate` permission and current version, with independent human approval, no delegation, no inferred `bo:admin` and no free-text code authorization.
4. Execute these checks in the proposed protected transaction with database-clock revocation recheck, verified business scope, composite database constraints and separately reviewed least-privilege/forced RLS. The identity/ABA port must retain authority ownership; CL only consumes evidence.
5. Check authoritative default-blocking kill state before and during writes. Any service failure/refusal blocks. Never promote 06Q/06S structural checks into permission decisions or infer identity from DB GUCs.

## Explicit owner/security decisions outstanding

| Gate | Resolution required before trusted adapter code |
| --- | --- |
| 06T-ID | Confirm active canonical session backend and identity exchange, token validity and revocation route for this deployment |
| 06T-MEM | Select exact canonical user/business membership repository and relation proof, role qualification, and business-scope policy |
| 06T-ABA | Approve scoped explicit permission issuance/revocation representation, version/provenance, human approval and fresh read port |
| 06T-DB | Define trusted business context plus composite FKs, forced RLS, roles and guarded SQL writer |
| 06T-KILL | Name custodians and authoritative kill state, recovery and break-glass control |
| 06T-AUDIT | Approve retention legal particulars, canonical encoding and independent signer/anchor custody |
| 06T-PR | Merge/reconcile #310–#312 only after tests; do not treat open upstream PRs as merged APIs |

## Verification and authorization

This is a **source-discovery specification**. Actual token/permission/role runtime traces, CI runs and PostgreSQL acceptance have **not** been executed. No new adapter, credentials, grants or schema have been created.

**Decision:** Design discovery may continue. **Trusted adapter integration gate remains CLOSED** until the exact interfaces are reviewed by identity/ABA/DB/security owners and a separate isolated implementation scope is explicitly approved. No permission grant, migration, production deployment, live Shadow Mode or Continuous Learning learning release is authorized.
