# CL-ACT-06W — Canonical ABA Permission Issuance, Revocation & Provenance Verification

**Status:** STATIC SOURCE VERIFIED — CL PERMISSION GATE **BLOCKED**.  
**Main baseline:** `cb70a30fabaf9a0840bdf54b67ef3f5955035612` (PR #316 merged).  
**Authorization:** design/source verification only; no grants, migrations, production activation or learning release.

## Verified canonical sources

- `packages/database/src/repositories/approved_action/ApproverAuthorityRepository.ts`: `grantActiveAssignment` inserts active assignment, first version and provenance in one `withTenantTransaction`; duplicate assignment code is caught and returns existing with `created:false`. This is **not** proof of a CL-specific grant.
- `revokeAssignment` locks the assignment row `FOR UPDATE`, changes status to `revoked`, appends revocation provenance to the latest version, and returns `changed:false` when already revoked. Revocation does not automatically invalidate cached CL claims outside an integrated authoritative read.
- `findActiveForUser` queries active assignment by business, user and assignment code; it does **not** validate a dedicated CL permission model, a separately verified human approver, unexpired issuance, delegation exclusion, or fresh version provenance.
- `listProvenance` reads `approval_authority_scopes` for `scope_type='provenance'`, ordered by timestamp and ID. `getCurrentRoleCode` reads latest role code, **not** an explicit CL right.
- `authorityProvenance.ts` defines `AuthorityProvenanceEntry` with action, source (`onboarding`/`manual-admin`/`backfill`), business/assignment IDs, state, server-derived actor and ownership proof. Its canonical source of truth is `approval_authority_scopes`, **not** `approval_audit_events` (which records approval decisions).
- `packages/workflow/src/DecisionWorkflowService.ts`: `grantApproverAuthority` verifies business scope and active workspace membership, invokes ABA active assignment/provenance with `aba:admin` actor; `revokeApproverAuthority` uses normalized reason, finds business assignment and revokes with provenance. These concern **approver assignments**; no automatic equivalence with `cl:shadow:evaluate`.
- `packages/onboarding/src/OwnerApproverAuthorityService.ts`: `business-owner-approver` bootstrap is limited to proven specific business ownership and avoids re-granting revoked/ambiguous assignments. This bootstrap MUST NOT issue or imply CL permission.

## Critical unverified security contracts

| Gate | Required prior to a trusted CL adapter |
| --- | --- |
| W-ISSUE | ABA owner ratifies a typed, explicit `cl:shadow:evaluate` grant, issuer, approval workflow, business scope, start/expiry, grant identity and immutable provenance |
| W-REVOKE | Current-state revoke port with immediate denial under the same transactional authority boundary and no cached acceptance |
| W-VERSION | Fresh active assignment/version, scope membership and database-clock validity, including independent verified human approver and no delegation |
| W-PROVENANCE | Verifiable provenance actor and source with cross-scope consistent tenant/workspace/business/version references, not merely a free-text role code |
| W-RACE | Concurrency and lock-order design so revocation cannot race past a trusted audit/control write |
| W-DB | Restricted role, composite FK, FORCE RLS, trusted principal context and independent disposable PostgreSQL denial testing |

## Regression acceptance matrix (not executed)

1. A `business-owner-approver`, `approver` or `bo:admin` assignment with no CL right **must refuse**.
2. Grant of explicit CL right with absent, ambiguous, wrong-business or inactive membership **must refuse**.
3. Revoked assignment/version or expired grant **must refuse** at current database time, including after attempted retry.
4. Delegated, self-approved, unverifiable or nonhuman approval **must refuse**.
5. Provenance missing or inconsistent in tenant/workspace/business/assignment/version **must refuse**.
6. Simultaneous revoke and attempted CL write must result in defined atomic ordering with no accepted stale authority.
7. Kill-switch ON/unreachable always denies; audit/control rollback must preserve append-only history; no model/policy/BO writes.

## Ratification and migration decision

The owner approved H-RET/H-HASH/H-AUTH/H-TXN/H-KILL **for development specification only**. No policy approval authorized actual issuance of CL permission, database grant, migration, live route, or Continuous Learning activation. Existing ABA grant/revoke methods must not be repurposed for CL without explicit ABA/domain/security owner decisions and separate, verified implementation.

**Verdict:** ABA issuance/revocation/provenance source discovery and static code verification complete; genuine CL permission issuance, revocation freshness and independent approval remain **NOT VERIFIED / NOT IMPLEMENTED**. No automated CI, integration test or PostgreSQL test was executed for this block.
