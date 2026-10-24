# CL-ACT-06Z — ABA Permission Data Model Decision & Migration Design Gate

**Status: CONDITIONAL DESIGN RECOMMENDATION — OWNER/DB SECURITY DECISION PENDING; MIGRATION GATE CLOSED.**
**Baseline main:** `bfff74aa425456746cc502cfb0c27940e3b5040e`; #317 and #318 merged, #319 still open at inspection. Reconcile #319 before adopting any model.

## Chosen design recommendation for owner review (NOT an owner-ratified operational choice)

**Recommend a dedicated, typed ABA-owned `cl:shadow:evaluate` grant aggregate**, rather than mapping the existing general-purpose `approver_assignments.assignment_code` or `role_code`. The new relation would remain strictly ABA-owned and would be separately reviewed before a numbered migration. This is a proposal, not a permission issued or owner approval.

### Logical entities and integrity constraints

1. **Permission grant:** immutable `grant_id`; composite `tenant_id/workspace_id/business_id`; grantee; exact typed permission code; `pending/active/revoked/expired` state; current positive version; database-time `valid_from/expires_at`; issuer and correlation/idempotency reference. A grant may be activated only with separate independent approval.
2. **Approval evidence:** separate `approval_decision_id`, authenticated human approver and source authority, nondelegated direct action, decision time and bounded reason codes. Operator, issuer and approver distinctions must be explicitly reviewed; operator/approver identity equality always refuses.
3. **Immutable version/events:** every request, approval, issue, revoke and expiry appends ABA-owned provenance linked to grant/version, scoped business and authoritative actor; no direct UPDATE/DELETE/TRUNCATE to history by service roles. Existing `approval_authority_scopes` history pertains to approver assignments and must not be silently reused as proof of CL grants.
4. **Composite scope keys:** migration candidate must demonstrate FKs that prove tenant/workspace/business lineage across business, membership, grant and evidence records; RLS `FORCE ROW LEVEL SECURITY` and least-privilege GRANT/REVOKE matrix to be verified on actual PostgreSQL schema. Individual foreign keys alone are insufficient.
5. **Uniqueness:** one unambiguous current active grant per (tenant,workspace,business,grantee,permission) is recommended; historical revoked grants retained separately. Choose partial unique indexes, version uniqueness and pending-request idempotency scope after concurrency review.
6. **Expiry and revocation:** ABA-owned locked revoke transaction + immutable evidence; no resurrection of revoked grants, separate new approval for replacement. Trusted readers check DB-clock validity/current version under reviewed lock order, including CL transaction recheck and retries. Expired state must deny even if a background expiry transition has not run.
7. **Separation:** no CL mutation of ABA grant rows; no BO owner/bootstrap/\`bo:admin\` implicit mapping; CL only reads current authority and maintains its own shadow audit/control, with default blocking kill switch.

## Proposed interface signatures (DESIGN ONLY)

- `requestClShadowPermission(session, scopedBusiness, grantee, idempotencyKey): PendingGrantRef | Refusal`
- `approveClShadowPermission(independentHumanSession, pendingGrantId, decision): GrantRef | Refusal`
- `revokeClShadowPermission(authorizedRevokerSession, grantId, boundedReason): RevocationRef | Refusal`
- `verifyCurrentClShadowPermission(trustedPrincipal, scopedBusiness, protectedTransaction): CurrentGrantEvidence | Refusal`

All session authority and scope evidence originate in canonical services, never caller-owned boolean flags. Interface names are suggestions, not installed endpoints.

## Binding decisions that must be resolved before SQL creation

| Decision | Owner/security review required |
| --- | --- |
| Z-MODEL | Dedicated grant aggregate vs typed ABA extension; current-state source of truth and exact lifecycle status schema |
| Z-SCOPE | Composite key/FK relationships, membership qualification, active business semantics and prohibited cross-scope access |
| Z-APPROVE | Separate permitted issuer/revoker and independent direct human approver roles, grant provenance and anti-delegation proof |
| Z-IDEMP | Concurrency-safe uniqueness, expiry/index semantics, scoped idempotency key, version transitions and replay policy |
| Z-RACE | Lock order, database isolation, current ABA reads, revocation ordering, bounded retry/rollback evidence |
| Z-RLS | Database ownership, service roles, security-definer safeguards, FORCE RLS/GRANT plan |
| Z-OPS | Legal retention, key/anchor custody, kill-switch named custodians and incident procedure |
| Z-DEPS | Reconcile #319 review and perform architectural/security sign-off on the final candidate before authorization |

## Migration readiness verdict

**NOT READY.** The user approved H-RET/H-HASH/H-AUTH/H-TXN/H-KILL for *development specification only*. No exact DBA privilege matrix, canonical CL permission authority source, composite FK design, or separately verified owner approval for operational parameters and disposable migration execution is present in this block.

Do not add a numbered SQL migration or permission API, issue/revoke permissions, assign DB roles, run PostgreSQL, deploy routes, enable Shadow Mode, or activate Continuous Learning. After documented owner/security selection of Z-* choices, request separately scoped authorization for a disposable-only implementation and RLS acceptance block. Evidence must cover unauthorized issuance/revocation, independent approval, cross-business access, concurrent revoke/grant/read, append-only refusal, kill-switch precedence and zero model/policy/BO mutations.

**Verification:** Documentation authored; no CI or database test executed.
