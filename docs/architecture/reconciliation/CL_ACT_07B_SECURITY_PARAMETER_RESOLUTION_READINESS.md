# CL-ACT-07B — Security Parameter Resolution & Implementation Readiness Assessment

**Assessment date:** 2026-10-24. **Base main:** `9a4ef79af02ee9cdd982b39ad351881c22daf3af` (#322 owner-approved development decisions merged; no open PR at initial inspection).  
**VERDICT: NOT READY FOR IMPLEMENTATION OR MIGRATION.** Document-only security readiness audit. No operational parameter is silently chosen.

## Binding authority and preservation

CL-ACT-07A owner approved Z-MODEL, Z-APPROVE and Z-DEPS; approved Z-SCOPE, Z-IDEMP, Z-RACE, Z-RLS and Z-OPS with five protective amendments. Preserve all existing business functionality and architecture, allow eligible **nonowner** business operators by verified business relationship, demand fresh revocation-safe default-deny authorization and isolated database/rollback tests, maintain default-OFF Shadow Mode and inactive Continuous Learning, and prohibit BO/model/policy mutations. The owner **explicitly reserved** legal retention jurisdiction, KMS/key custody, named emergency custodians, exact database-role privileges, idempotency parameters, transaction isolation and lock order, and canonical business relationship verification interface.

## Seven-parameter readiness matrix

| Parameter | Verified source/evidence | Proposed resolution process | Status |
| --- | --- | --- | --- |
| B1 Legal retention jurisdiction/controller | H-RET proposed 24-month metadata retention conditional on legal review; no binding jurisdiction/controller identified by owner | Obtain privacy/legal authority, classification, records schedule and litigation-hold/DSAR treatment; record a signed retention decision; prevent automatic purge until then | **BLOCKED** |
| B2 KMS/key custody and signing anchors | H-HASH design-only: SHA-256 canonical JCS hashes, external signed anchors every 15 minutes or 1000 events; custody and trust-root absent | Name key owner, KMS/provider, separation-of-duty, rotation/recovery, anchor sink, integrity/availability tests and independent verifier | **BLOCKED** |
| B3 Emergency kill-switch custodians | H-KILL design-only: kill ON by default; proposed two independent human custodians to restore; no named identities/storage policy | Identify primary/alternate custodians and approve two-person recovery authority, quorum, source-of-truth, outage rule and incident evidence | **BLOCKED** |
| B4 Exact database-role privilege matrix | `packages/database/src/client.ts` implements tenant/workspace/user transaction GUC binding; migration 0095 has individually referenced tenant/workspace/business IDs; no reviewed CL grant role matrix | Inventory actual DB roles, grants and RLS policies, design composite business-scope FKs and FORCE RLS, independent no-bypass role tests in disposable DB | **BLOCKED** |
| B5 Idempotency policy | Existing ABA `ApproverAuthorityRepository.grantActiveAssignment` catches unique conflict; CL grant ID/key scoping, TTL/replay and active-grant constraints not locked | ABA/security owners choose request key format/TTL, same-payload response, conflict/refusal semantics, uniqueness/version rules; test concurrent/replayed requests | **BLOCKED** |
| B6 Transaction isolation/lock order | Existing ABA revoke uses `FOR UPDATE` + same-transaction provenance; protected CL read/ABA revoke race model and SQL lock order not approved | DB/security owners define lock hierarchy and transaction isolation, failure/retry SQLSTATE policy, kill-switch current-read behavior, revocation linearization; independent concurrency tests | **BLOCKED** |
| B7 Canonical business relationship verification interface | `apps/api/src/plugins/tenantContext.ts` validates active workspace membership; `MembershipRepository.getByUserAndWorkspace` is workspace-only; `classifyOwnership` verifies owner evidence only | Identity/Business/ABA owners agree nonowner-capable business relationship source, exact typed API, verified scope/active status, instant revoke and compositional RLS | **BLOCKED** |

## Existing verified boundaries, not authority to activate

1. `AuthenticationService.validateSession` rejects revoked/expired sessions and inactive users; it authenticates a principal, not permission.
2. `tenantContext.ts` binds workspace membership to authenticated user, but does not establish business-specific CL permission.
3. `ApproverAuthorityRepository` can atomically grant/revoke ordinary ABA *approver assignments* with provenance; this does **not** create `cl:shadow:evaluate` grants or independently approved CL rights.
4. CL-ACT-06S/06V reviewed pure structural contracts remain non-authorizing (`authorized:false`, `auditWritePermitted:false`, `learningActivated:false`).
5. Other subsystems' kill switches are not proof of an authoritative CL kill switch. No CL operational wiring is established here.

## Dependency and acceptance plan — independent blocks, never auto-advance

**07B-1 — Parameter owners and evidence:** obtain seven authority decisions as separately signed records, explicitly distinguishing owner-approved principle from missing executable values. No secret values or key material in Git.

**07B-2 — Canonical business relationship & ABA source verification:** trace trusted identity, nonowner business relationship, ABA grant/approval/revocation and business lifecycle, produce an authoritative interface map. Reject caller flags and inherited owner/admin permission.

**07B-3 — DB role/scope and transaction security design:** write candidate composite FK/RLS/role and lock-order analysis *without numbered migration*. Require review of PostgreSQL transaction isolation, least privilege, revoke races, append-only behavior, and schema compatibility.

**07B-4 — Independently authorized disposable testing:** only on later, express owner permission; isolate database, inspect real roles and FORCE RLS, test negative cross-tenant/business access, stale grants, concurrent revoke/read/write, kill-switch failure and rollback. Capture executed test outputs and exact schema fingerprints.

**07B-5 — Separate production authorization:** even after disposable proof, further owner/security review and separate deployment authorization; never automatically enable Shadow Mode or Continuous Learning.

## Readiness gates

| Gate | Current result |
| --- | --- |
| Z-decisions owner ratified at development-policy level | **PASS** (#322 merged) |
| Seven parameter values ratified for implementation | **FAIL — 0/7 fully locked** |
| Genuine ABA-owned CL grant issuer/read/revoker | **NOT IMPLEMENTED/VERIFIED** |
| Business-specific nonowner relationship trusted interface | **NOT VERIFIED** |
| Composite business FK, DB-role RLS, isolation and race proof | **NOT VERIFIED** |
| Disposable DB rollback and deny-case tests | **NOT PERFORMED** |
| Production grant/migration/CL activation approval | **NOT AUTHORIZED** |

## Explicit prohibitions

No numbered migration, role GRANT/REVOKE, actual ABA CL grant issuance/revocation, database execution, deployment, Shadow Mode enablement, or learning/model/policy/BO mutation. Existing implementation and contracts are unchanged. A merged assessment PR only documents readiness and is never implementation authorization.

**Verification performed:** Static repository review and main/PR inspection only. **CI, PostgreSQL and production checks: NOT EXECUTED.**
