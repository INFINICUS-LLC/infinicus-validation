# CL-ACT-06X — Explicit CL Permission Issuance & Revocation Security Contract

**Status: SECURITY CONTRACT PROPOSED; NO PERMISSION ISSUED; IMPLEMENTATION GATE CLOSED.**  
Baseline main `cb70a30fabaf9a0840bdf54b67ef3f5955035612` (#316 merged). PR #317 (06W verification) remains open and must be reconciled before implementation.

## Source-of-truth boundary

ABA alone owns permission issuance, assignment state, versions, independent human approvals, and revocation. Identity owns session authentication; canonical membership/BO authority owns business relationships; CL consumes **read-only** ABA permission evidence and owns its own advisory audit history. Do not change layer or ownership boundaries. The approved seven governance policies and five H-security development policies remain applicable.

Existing ABA `ApproverAuthorityRepository.grantActiveAssignment`, `revokeAssignment`, `listProvenance` and `DecisionWorkflowService.grantApproverAuthority`/`revokeApproverAuthority` are **approver authority**, not explicit CL permission. Existing `business-owner-approver` bootstrap and `bo:admin` are never equivalent to `cl:shadow:evaluate`.

## Proposed ABA-owned typed lifecycle (not implemented)

### Issue request
- Authenticated operator and independent, verified human approver identities, separate individuals; no delegation, service-identity self-attestation or inherited admin grant.
- Canonical active tenant/workspace/business membership scope for intended recipient and approver, explicit permission code **exactly** `cl:shadow:evaluate`, narrowly specified purpose and validity interval.
- Proposed ABA grant reference: immutable grant ID; immutable version ID and monotonically increasing version; server-generated correlation/idempotency key scope; approval decision ID, approver identity, database-issued timestamp, provenance source and authorized issuer identity.
- Issuance allowed only through an ABA-owned, separately approved trusted interface. The API must reject caller-supplied `verified`, `approved`, `issuer`, `versionCurrent` and analogous authority booleans. No issuance API exists or is enabled by this document.

### Active read
- A separate, ABA-owned **current grant verification** port must verify scope, recipient, assignment/version linkage, nondelegated independent human approval, valid start/expiry at database time and unrevoked status.
- Return strict, immutable evidence or an explicit refusal. Do not return a transferable bearer or authorization token. An ABA record cannot grant CL operation merely because it is structurally well formed.
- A CL audit/control operation must recheck current ABA authority inside its protected transaction and after any serialization retry, using independently reviewed lock ordering and forced RLS/composite relational scope.
- Duplicate, stale, missing, ambiguous or conflicting grant/provenance evidence fails closed.

### Revoke request
- Only a canonically authenticated and ABA-authorized revoker may initiate revocation. Emergency shutdown is separately available through approved kill-switch custody and must not depend on the revoker being online.
- ABA atomically marks current grant revoked, creates an append-only event linking the revoked version and bounded reason code, preserves immutable history, and invalidates active read evidence immediately under defined serialization rules.
- Repeated revocation of the same grant is idempotent; regrant requires a **new** independent decision and fresh grant/version, never resurrection of a revoked record or silent reuse of old evidence.
- Cancellation, expiration, workspace membership suspension, business deactivation, or identity revocation must cause the CL authorization consumer to deny, regardless of stale cached grant objects.

## Security properties to verify before implementation

| ID | Acceptance requirement |
| --- | --- |
| X-01 | Exact ABA issuer/revoker and privilege check defined by ABA owner; no direct CL mutation of ABA tables |
| X-02 | Proven independent human approval, nondelegation, active membership and business-specific scope |
| X-03 | Typed permission, current grant/version/provenance and database-time validity; no free-text assignment-code substitution |
| X-04 | Atomic grant/revoke versioning, append-only provenance, idempotency and race-safe read/write behavior |
| X-05 | Immediate stale/revoked refusal including authorization recheck on every transaction retry |
| X-06 | Restricted role and composite tenant/workspace/business keys, FORCE RLS, trusted transaction context; denied cross-business reads/writes |
| X-07 | Active kill switch/unavailable state overrides all purported rights; advisory CL only, zero learning/model/policy/BO writes |
| X-08 | Privacy retention, signer custody and incident operational parameters resolved with independent review |

## Explicit implementation STOP conditions

No exact ABA-owned CL grant table/port, human approval provenance representation, revoker role, grant expiration policy, DB lock order, composite FK and RLS role matrix, custody and retention review has been approved for operational execution. Source verification in #317 is pending merge. Review this contract as a design proposal; owner approval of H-security policies was only for development specification.

**Do not grant or revoke any actual permission, create numbered migrations, deploy a route, run SQL, activate production Shadow Mode or release Continuous Learning.** A separate scoped implementation decision and disposable PostgreSQL security acceptance are required first.

**Verification:** Documentation-only commit, no CI or PostgreSQL run.
