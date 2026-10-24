# CL-ACT-06O — Operational Security Parameter Resolution v1

**Disposition:** SOURCE-OF-TRUTH RECONCILED; OPERATIONAL AUTHORITY **NOT** RESOLVED; MIGRATION **NOT AUTHORIZED**.
**Baseline:** main `5646fec8f80405da9ae5209a2ccbf6eee4b7e8a9` (#305 merged). Owner-approved development-specification record #306 remains OPEN at assessment; #302 and #304 also open. A draft PR or later merge is not operational approval.

## Owner-approved technical direction (do not change)

The owner approved H-RET / H-HASH / H-AUTH / H-TXN / H-KILL **for development specification only**, with no amendments, and explicitly prohibited permission grants, database migrations and Continuous Learning activation. Preserve the previously ratified seven baseline principles, including independent human approval, CL/ABA domain separation, default-off Shadow Mode and absence of learning/model/policy/BO mutation.

## Verified repository sources and operational implications

| Area | Repository evidence | What is settled / what remains |
| --- | --- | --- |
| Tenant DB context | `infinicus-platform/packages/database/src/client.ts` exposes `TenantContext {tenantId, workspaceId, userId}`, `withTenantTransaction` with transaction-local `app.tenant_id`, `app.workspace_id`, `app.user_id`, and `withSharedTenantTransaction` that refuses nested/cross-tenant or workspace joins | Existing transaction context **does not include businessId**, so CL business-scope checks and trusted principal binding require an explicit new contract and security review; custom settings alone are not proof of authentication |
| Canonical ABA authority | `packages/database/src/repositories/approved_action/ApproverAuthorityRepository.ts` owns assignments, assignment versions, authority scopes and delegations, with active-assignment lookups | Existing approval assignments cannot be interpreted automatically as `cl:shadow:evaluate`; need named issuer, exact grant/revoke/read-port, provenance and current-version checks; no delegation |
| Audit precedent | `packages/database/tests/audit-events-append-only.integration.test.ts` validates existing `audit.audit_events` migration 0181 under app and admin roles, including RLS, mutation/ TRUNCATE refusal | Valid test **pattern**, not evidence that a new CL audit schema exists, is append-only, or has passed PostgreSQL acceptance. Do not reuse its existing audit table as the CL-controlled source of truth |
| Shadow default-off gate | `packages/outcome-monitoring-runtime/src/ControlledShadowEvaluation.ts` rejects absent/disabled controls, kill-switch ON, and mismatched tenant/workspace/business scope; results always `releaseAuthorized:false`, `learningApplied:false`, `mutationsPermitted:false` | Pure offline caller-provided control; **no authenticated kill-switch authority store**, custody protocol or canonical grant validation; never wire caller-supplied controls directly to live access |
| Technical policy decisions | CL-ACT-06N owner approval is for development specification, including proposed metadata-only retention target, integrity anchor cadence, ABA authority, atomic idempotency and kill-switch design | NOT authorization for DB privileges, migration, externally signed anchors, live evaluations, or production learning |

## Operational parameter disposition (owner approved design; exact values missing)

### H-RET — PRIVACY-REVIEW BLOCKED
Approved design target: minimal metadata and digests; 24 months **conditional**, no deletion/purge until privacy/legal acceptance. **Still missing:** INFINICUS LLC legal-controller confirmation, applicable jurisdictions, legal basis, retention schedule approval, DSAR/redaction and litigation-hold policy, named privacy reviewer. No automatic deletion job.

### H-HASH — CUSTODY / WIRE-FORMAT BLOCKED
Approved design target: versioned SHA-256 over RFC 8785/JCS canonical JSON, per-control hash chain, independent signed external checkpoint every 15 minutes or 1,000 events. **Still missing:** exact payload schema and encoding constraints, hash domain-separator bytes, KMS provider and key aliases, separately authorized key custodian, independent anchor store, signer ACLs and key rotation, recovery/incident plan. The prior in-memory SHA-256 rehearsal verifies only consistency of caller-supplied data.

### H-AUTH — CANONICAL GRANT / DB-SCOPE BLOCKED
Approved design target: explicit ABA-issued `cl:shadow:evaluate`, current permission version, independent approver and no delegation, no inherited admin rights, FORCE RLS and composite tenant/workspace/business references. **Still missing:** canonical grant/revoke and verified read APIs, permission record type, independently verified provenance, app and owner role names/grants, trusted DB context including businessId, composite-FK model, secured writer/function and role threat model. Existing `app.user_id` in a DB transaction must never be assumed to be a verified identity merely because it was set.

### H-TXN — CONTROL-STATE BLOCKED
Approved design target: one transaction for current authorization, control state transition and append-only audit, scoped idempotent replay/collision refusal, control row lock, at most three bounded serialization retries. **Still missing:** authoritative CL control-state schema, lock ordering and isolation level, event sequence ownership, retryable SQLSTATE/backoff rules, precise canonical input equality and revocation race semantics. Existing shared tenant transaction helpers provide a useful foundation, **not** the new atomic authorizing write port.

### H-KILL — CUSTODIAN BLOCKED
Approved design target: default blocking, one authorized emergency shutdown actor, two independent recovery approvals, audit decisions, fail closed on unavailable state, proposed 15-minute incident acknowledgment. **Still missing:** named accountable INFINICUS LLC security administrator and alternate recovery custodians, canonical switch backing store/replication, break-glass path, on-call escalation, emergency testing and published operational runbook. No existing offline `killSwitch:boolean` input constitutes production custody.

## Owner assignment matrix (roles are proposals, not appointments)

- H-RET: INFINICUS LLC accountable legal/privacy owner and counsel/privacy reviewer.
- H-HASH: independent KMS/cryptographic key custodian and separate DB administrator.
- H-AUTH: platform identity/ABA owner plus PostgreSQL/RLS security reviewer.
- H-TXN: CL domain architect and database concurrency owner.
- H-KILL: named primary security incident custodian and distinct recovery approvers.

No person's identity, credentials, access or legal obligation is assigned by this report.

## Required next implementation authority (separate gate)

1. Reconcile and review PR #306 owner-approved policy record; preserve distinct status of open #302/#304.
2. Capture explicit approved exact parameters and accountable reviewers for all five H decisions; resolve all source-boundary inconsistencies, including DB business scope.
3. Review proposed CL-owned schema and canonical read/write ports against ABA/identity ownership; choose migration number only after independent DB/security sign-off.
4. Obtain **separate explicit disposable-only implementation authorization** before executing any migration or creating roles/permissions.
5. On disposable PostgreSQL only, prove privileged versus restricted role behavior, FORCE RLS and composite scope, grant/revocation correctness, UPDATE/DELETE/TRUNCATE denial, transaction rollback and concurrent replay, true server-side hashes/external anchor check, kill-switch precedence and zero learning/model/policy/BO writes. Record SQL/CI logs and test counts. Do not mark skipped tests as passed.
6. Production migrations, live Shadow Mode and learning activation remain distinct, later owner authorizations.

**Acceptance verdict:** operational parameter reconnaissance complete; five operational bindings incomplete; **NO MIGRATION / NO IAM GRANTS / NO POSTGRES TEST / NO LIVE SHADOW / NO CONTINUOUS LEARNING**.
