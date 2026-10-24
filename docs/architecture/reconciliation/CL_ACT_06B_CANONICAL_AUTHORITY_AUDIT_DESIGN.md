# CL-ACT-06B — Canonical operator authorization and audit persistence reconciliation

Status: **DESIGN/SAFETY CORRECTION ONLY — NO AUTHORITY GRANT OR DATABASE MIGRATION**.
Base: main `423550267e35be7858f0a9a21f00f82add5d115f`.

## Source-of-truth reconciliation

1. Canonical ABA authority lives in `approved_business_action.approver_assignments` with explicit tenant/workspace/business/user scope, mutable `status`, and `latest_version`. `approver_assignment_versions` is the historical version store. `approval_authority_scopes` records append-only scope and provenance information. `approval_delegations` is a separate status-and-time-bound capability. Implementation reference: `packages/database/src/repositories/approved_action/ApproverAuthorityRepository.ts` and migration `0095_create_aba_approvers_authority.sql`.
2. This schema does **not** prove that a particular assignment carries `cl:shadow:evaluate`. A matching free-text assignment code is not itself a permission grant. No existing ABA approval may be silently repurposed to authorize CL operator actions.
3. `ShadowOperatorAuthorityProposal.ts` is a pure, caller-supplied proposal preflight. Its `acceptedForReview` flag is not an authoritative decision, and the supplied `evaluatedAt` is not a trusted clock. CL-ACT-06B corrects the accidentally double-escaped ISO UTC regex and adds regression cases; the proposal still grants no authority.

## Proposed read-only canonical authority adapter (approval required)

A future OM/CL-specific composition should:
- Authenticate the principal through the platform's canonical identity/session mechanism, never from a request-body operator ID.
- Read an explicitly approved shadow permission assignment and its latest version, scope and grant provenance through its owning authority service/read port. Do not query or mutate ABA-owned tables from CL.
- Read database clock, verify current active status and revocation, version consistency, operator/approver separation, scoped grant and authority freshness in one transaction. **No delegation** in initial rollout; no implicit `bo:admin` or other privilege inheritance.
- Treat ambiguity, revoked or missing assignment, stale version, duplicate grants, missing proof, cross-scope identity, clock errors and service failure as refusal. Kill switch has highest priority.
- Return only advisory shadow evaluation authorization for that exact scope and control version; never production learning/mutation authorization.

## Proposed append-only audit persistence (owner schema decision required)

Propose a CL-owned `shadow_control_audit_events` append-only table, not an additional ABA assignment ledger. Required fields:

- Primary event ID; scoped tenant/workspace/business IDs; operator/approver identities; canonical assignment ID and assignment-version ID; control ID/version; correlation/idempotency key.
- Immutable event type (`REQUESTED`, `APPROVED`, `REVOKED`, `REFUSED`, `EVALUATED`), refusal reason codes, advisory-only result markers, source digest and versioned canonical encoding; database-issued timestamp; predecessor event/digest where applicable.
- Unique scoped event idempotency key; foreign keys and composite scope checks; forced RLS for tenant/workspace/business; narrowly scoped insert privilege; enforced prohibition on UPDATE/DELETE/TRUNCATE; no secrets or raw customer/business facts in audit payload.
- Append and corresponding control decision in the same database transaction with retry-safe concurrency behavior; a failed audit append means no control transition.

**STOP before choosing migration number, creating the table, granting IAM/RBAC permission, activating a route, or turning on any production feature flag.** Owner decisions required: shadow-control authority owner and permission issuance policy; audit schema/domain ownership; audit retention and integrity canonicalization; revocation/supersession; independent approver rule; operational kill-switch custody.

## Acceptance plan after owner approval

On a **disposable** PostgreSQL database with a restricted app role and admin fixture role, prove: active grant/expiry/revocation; independent approver; canonical version and database time; tenant/workspace/business isolation; concurrent idempotent approval; append-only UPDATE/DELETE/TRUNCATE refusal; audit atomicity; kill-switch priority; no model/policy/BO mutations; no OM→CL learning release. No production database connection.

No claimed production readiness or learning activation. Tests/CI for current regex correction remain unverified at commit time.
