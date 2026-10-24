# CL-ACT-06P — Canonical Business-Scope Authorization & Audit Writer Specification

Status: **SPECIFICATION ONLY / MIGRATION NOT AUTHORIZED**.
Baseline main: `5646fec8f80405da9ae5209a2ccbf6eee4b7e8a9`. PRs #302, #304, #306 and #307 were open at inspection; reconcile before integrating implementation. The owner's H-RET/H-HASH/H-AUTH/H-TXN/H-KILL approval applies to development design only. Production Continuous Learning remains disabled.

## Grounded existing contracts

- `infinicus-platform/packages/database/src/client.ts`: `TenantContext` carries `tenantId`, `workspaceId`, `userId`; transaction-local `app.tenant_id`, `app.workspace_id`, `app.user_id` are set by `withTenantTransaction`. `withSharedTenantTransaction` shares the scoped transaction and rejects cross-tenant/workspace joins. There is **no businessId in this context**.
- `packages/database/src/repositories/approved_action/ApproverAuthorityRepository.ts`: ABA owns assignment/status/version and scopes; `0095_create_aba_approvers_authority.sql` stores separate tenant/workspace/business IDs on assignment and version, but its standalone references do **not** create composite evidence of consistent scope.
- `ControlledShadowEvaluation.ts`: currently a pure offline gate, with caller-supplied controls, not authenticated permission, durable kill state or audit writer. Its outputs remain advisory with permanently false learning/mutation markers.
- Existing `audit.audit_events` PostgreSQL append-only tests are precedent for restricted app-role and admin-role negative checks, not evidence of CL audit acceptance.

## Authorization trust contract: proposed, requires database/security review

1. Authenticate using the canonical platform session. The server, not the incoming payload, binds verified operator ID, tenant and workspace. Resolve business membership or authorization from canonical ownership records. Verify that business belongs to the same tenant and workspace through authoritative relationships and composite-scope constraints. **Do not trust `set_config('app.user_id', ...)` alone as proof of authentication.**
2. Define a narrow `VerifiedBusinessPrincipal` read-only projection: `tenantId`, `workspaceId`, `businessId`, `userId`, `sessionId`, `authenticationAssurance` and trusted provenance. Issuance must be unavailable to general route callers; no public factory accepting arbitrary IDs. This is a proposed interface, not an implemented principal type.
3. Only ABA's canonical permission owner may issue and revoke explicit `cl:shadow:evaluate`; independent human approver required, operator != approver, no delegation, no `bo:admin` inheritance. CL consumes a read-only verification port proving active current assignment ID/version ID and scoped provenance. A free-text `assignment_code` or `role_code` alone is **not** permission proof.
4. The canonical authority read must be transactional and current: verify assignment status, latest version, revocation, scope and expiry using database time. Lock appropriately to prevent change between check and write. Missing authority evidence, ambiguous assignments, service failure, stale version or independent-approver mismatch all refuse.
5. Existing `TenantContext` must remain backwards compatible. **Do not globally add an optional caller-provided `businessId` and assume that makes RLS secure**. Add a dedicated, trusted CL business-scope composition after its ownership and session-provenance rules are finalized.

## Proposed CL audit writer contract (not a deployed port)

- Operation input: authenticated `VerifiedBusinessPrincipal`; requested scoped control ID and expected version; idempotency key and approved operation type; source-evidence digest; independent approval evidence reference. **Request must not supply authoritative operator, approval decision, current control state, digest/sequence or kill-switch state.**
- Within ONE server-controlled database transaction: validate kill-switch store (default blocking); validate canonical session and business membership; obtain current ABA authorization/approver evidence (recheck after serialization retry); lock CL-owned control version; validate expected version and idempotency; calculate server-side canonical payload digest and predecessor/sequence; append CL-owned immutable audit record; transition CL-owned control state; commit atomically.
- Same scoped key and byte-identical canonical input replays original result; same key/different canonical input fails closed. Audit failure rolls back transition. At most three retries for explicitly reviewed PostgreSQL serialization/deadlock errors with bounded backoff and renewed authority checks.
- Database control table and CL audit ledger must use composite scoped keys, FORCE RLS, least-privilege role grants, guarded insert-only writer and no UPDATE/DELETE/TRUNCATE by application role. Audit head signatures require independently controlled external KMS and anchors at the owner-approved proposed cadence, but key provider/storage/custodians remain unset.
- No OM-to-CL positive learning release, live activation, model/policy changes or Business Operations mutations may be reachable from this port.

## Security questions blocking schema or writer implementation

| ID | Must be resolved |
| --- | --- |
| P-AUTH-1 | Canonical identity session verification and source-proven business membership contract |
| P-AUTH-2 | ABA's explicit permission representation, issue/revoke/read port and locked active-version proof |
| P-SCOPE-1 | Composite tenant/workspace/business keys and exact trusted DB role/session-context mechanism |
| P-TXN-1 | CL control-state source, SQL isolation/lock ordering, idempotency and revocation races |
| P-AUDIT-1 | Audit canonical byte schema, chain/anchor custody, legal retention and immutable-data privacy controls |
| P-KILL-1 | Named kill-switch custodians, authoritative switch storage and recovery procedure |

## Disposable PostgreSQL acceptance plan (not executed)

After separate owner-approved disposable-only implementation authorization: use isolated newly provisioned PostgreSQL with distinct owner, restricted writer, read-only auditor and fixtures roles; prove denied arbitrary business ID substitution, tenant/workspace/business RLS and composite FK isolation, expired/revoked ABA assignment refusal, self-approval/delegation refusal, kill-switch default-deny/priority, UPDATE/DELETE/TRUNCATE refusal, same-key exact replay vs changed-input rejection under concurrent requests, audit/control atomic rollback, database-time validity, externally verified anchored integrity and **zero** learning/model/policy/BO writes. Capture actual test output and grants; skipped cases do not pass.

**Stop conditions:** No numbered migration, runtime audit writer, permission grant, database operation, production change or Continuous Learning activation is authorized by CL-ACT-06P.
