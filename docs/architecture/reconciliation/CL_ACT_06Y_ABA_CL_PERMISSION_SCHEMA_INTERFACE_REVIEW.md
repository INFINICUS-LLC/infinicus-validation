# CL-ACT-06Y — ABA-Owned CL Permission Schema & Interface Design Review

**Status: DESIGN REVIEW COMPLETE; IMPLEMENTATION AND MIGRATION NOT AUTHORIZED.**
Base main: `cb70a30fabaf9a0840bdf54b67ef3f5955035612` (#316 merged). Predecessors #317 (06W) and #318 (06X) remain OPEN at review. Align them before implementing this design.

## Evidence from authoritative repository

`infinicus-platform/infrastructure/database/migrations/0095_create_aba_approvers_authority.sql` defines `approved_business_action.approver_assignments` (business-unique `assignment_code`, status `draft/active/revoked`, `latest_version`), version table, `approval_authority_scopes` JSONB evidence and a general delegation table. Their individual foreign keys do **not** guarantee that referenced IDs carry matching tenant/workspace/business, and the free-text `assignment_code` is not a typed explicit CL permission.

`ApproverAuthorityRepository.grantActiveAssignment` atomically stores active assignment/version/provenance; `revokeAssignment` locks its row and stores revocation provenance; `findActiveForUser` filters by business, user, assignment code and status. Those interfaces implement general approver assignment lifecycle **not** `cl:shadow:evaluate` issuance/verification, grant expiry, nondelegated independent approval, or locked fresh current-version authorization.

`authorityProvenance.ts` declares `approval_authority_scopes` with `scope_type='provenance'` as the canonical append-only ABA grant/revocation history. Do not relocate ABA ownership into CL or duplicate its authority history in `approval_audit_events`.

## Proposed ABA-owned CL permission schema — NOT executed SQL

**Recommend a dedicated typed ABA permission-grant relation rather than mapping existing owner/approver assignment codes.** Candidate logical model (column names are review proposals):
- `grant_id` UUID; `tenant_id`, `workspace_id`, `business_id`, `grantee_user_id`; `permission_code` constrained to exactly `cl:shadow:evaluate`; status `pending/active/revoked/expired`; `version` positive integer; `valid_from`, `expires_at` (database time), issuer ID and canonical session/provenance reference.
- `approval_decision_id`, independent human `approver_user_id`, verified direct/nondelegated authorization source, reason code, `correlation_id` and idempotency scope.
- Append-only ABA-owned grant lifecycle events keyed by grant/version and request correlation, including issuance, approval, activation, revocation and expiration. Do not mutate historical rows.
- Composite tenant/workspace/business constraints and reviewed unique indexes should enforce grant scope and active-grant uniqueness as the policy decides. Cross-scope FKs must be verified against actual authoritative indexes before SQL drafting.
- No `role_code` or generic assignment code maps implicitly to CL permission. Explicit ABA-owned right and verified approval are independent of BO admin/owner status.

### Independent approval sequence (proposal)
1. ABA verifies session, correct business membership and permitted issuer; create **pending** candidate, not an active grant.
2. A different authenticated **human** approver with the separately confirmed ABA approval right supplies direct approval; prevent same-user, delegated or caller-claimed approval, check revocation and business scope.
3. ABA atomically activates current grant/version and appends immutable provenance. Recheck canonical user, business/membership and kill-policy preconditions at required transition points; CL shadow remains default OFF independently.
4. ABA publishes no operational permission token to CL; it exposes a read-only, current, transaction-safe verification response or refusal.

### Revocation and freshness sequence (proposal)
- ABA-authenticated revoker changes current grant to revoked and appends history in the same transaction under row lock. Duplicate revocations return the same refusal state without new authority.
- The verified-read port returns grant ID, current version, scope, approval and revocation evidence derived **only from authoritative storage**. Check `valid_from`/`expires_at` with database time; reject absent/duplicate/pending/stale/expired/revoked grants.
- Under separately reviewed lock order, CL rechecks current ABA authorization and independent approval within the atomic CL audit/control transition and on every serialization retry, preventing a stale accepted snapshot from bypassing revocation.
- Recovery/regrant must be a **new** independent decision and grant/version, never reactivation of the revoked object or archived provenance.

## Proposed interfaces and ownership (not implemented)

| Owner | Interface | Security contract |
| --- | --- | --- |
| Canonical Identity | `validateSession`-backed authenticated principal | Token hash, revocation, expiry, active user; no caller-attested identity |
| Business membership authority | `verifyActiveBusinessRelationship` (new proposal) | Tenant/workspace/business relation bound to authenticated operator; owner-only claims insufficient without requested permission |
| ABA issuer | `requestClShadowGrant` / `approveClShadowGrant` (new proposals) | Separate authenticated issuer and human approver; scoped pending → active; audited provenance |
| ABA revoker | `revokeClShadowGrant` (new proposal) | ABA-verified revoker, row lock, append-only reason and immediate refusal |
| ABA read port | `verifyCurrentClShadowGrant` (new proposal) | Current version, expiry, revocation, approval proof, nondelegated and scope-matched, transaction-safe |
| CL consumer | Read-only verification and separate audit writer | Cannot issue/revoke ABA grants; default blocking kill switch and no learning/model/policy/BO mutations |

## Decisions blocking numbered schema and implementation

1. ABA owner chooses dedicated grant table versus rigorously typed extension, concrete statuses, uniqueness, validity interval and expiry handling.
2. Identity/ABA owner specifies issuer, approver and revoker roles, provenance proof, direct human approval and exact permission registry.
3. Database/security owner confirms composite FK keys, FORCE RLS policies, role/GRANT matrix, SECURITY DEFINER restrictions and canonical transaction-context trust.
4. Security/CL architects ratify lock ordering, protected current-grant read, idempotency and revocation race order; define DBA-only migration/rollback controls.
5. Legal/security owners confirm retention and independently protected signing/anchor custody, kill-switch custodian and emergency recovery procedures.
6. Merge/reconcile predecessors #317 and #318, run automated tests and review migration candidate against the nine-layer architecture; explicitly obtain **separate disposable-only implementation authorization** before any SQL execution.

## Required disposable acceptance — FUTURE only

Negative tests for unauthorized issuer/revoker, self/delegated approval, invalid or cross-business membership, wrong composite scope, stale version, concurrent duplicate grants, revoked/expired state, racing revocation and CL write, tampered provenance, app-role UPDATE/DELETE/TRUNCATE, forced RLS and kill-switch fail-closed. Confirm zero BO/model/policy/learning mutation and provide actual PostgreSQL role, log and transaction evidence. These tests have **not** been executed.

**No migration created or run; no ABA grants issued/revoked; no operational adapter or database roles created; no production Shadow Mode or Continuous Learning activation.**
