# CL-ACT-06L — Owner Policy Resolution & Technical Parameter Lock v0.1

**State: CANDIDATE TECHNICAL PARAMETERS — NO OWNER RATIFICATION.**  
**Base main:** `2c48d9d2d1b49464b8856b01dfa3f337945864e1`.  
**Prior dependency:** PR #302 (CL-ACT-06K) is open, not merged. This block does not supersede it.

The owner approved seven general shadow governance principles only. Technical values below are bounded **recommendations for a future owner decision**, not silently accepted defaults. This document is a design lock proposal; actual lock is forbidden until decisions are individually ratified.

## H-RET — audit retention
**Proposed technical posture:** Metadata-only evidence, scoped references, standardized refusal codes, source digests; no raw PII, credentials, or financial payload. No automatic purge until a lawful retention/deletion schedule has been ratified. Schema should keep erasure-compatible linkage and legal-hold controls separate from immutable event evidence.

**Owner inputs required:** governing jurisdiction(s) and data controller; record classifications and lawful basis; exact duration(s); litigation-hold exceptions; deletion/anonymization procedure; accountable privacy reviewer. *Do not invent a retention duration.*

## H-HASH — canonical integrity
**Proposed technical posture:** Versioned canonical UTF-8 event encoding with explicit domain-separated digest and deterministic per-scoped-control sequence and predecessor hash. Calculate digest in the trusted database-side/authorized writer path, never accept an unverified caller digest. Protect signed head anchors in an independently controlled storage/key system with audit and recovery verification.

**Owner inputs required:** exact canonical encoding specification; sequence stream identity; signer/key management authority; algorithm and rotation policies; anchoring frequency and storage location; recovery and compromise-response protocol. *SHA-256 remains a proposal until complete canonicalization and anchor custody are approved.*

## H-AUTH — identity and RLS
**Proposed technical posture:** Canonical authenticated operator context; explicit `cl:shadow:evaluate` grant issued by identity/ABA owner only, current business-scoped assignment/version and provenance, independent human approver; no delegation and no `bo:admin` inheritance. A CL-owned scoped audit write port must deny requests without verified authority. FORCE RLS, tenant/workspace/business composite reference validation and least-privilege database grants.

**Owner inputs required:** exact canonical issuer/read-port; grant/revoke representation; principal-to-DB trusted context; app/owner/fixture role names and privilege matrix; security-definer function safeguards and session claim integrity.

## H-TXN — control state and atomicity
**Proposed technical posture:** Control and audit event written atomically within one transaction with scope and control version lock. Scope idempotency by tenant/workspace/business/control/operation/key and compare canonical input digest. Exact replays return original result; same key with different input refuses. Write failure rolls back control transition. Default disabled control.

**Owner inputs required:** control-state source schema; lock ordering and isolation; idempotency key and operation taxonomy; status/state machine; collision and retry handling; revocation-race policy.

## H-KILL — emergency custody
**Proposed technical posture:** Kill switch defaults to blocking; it takes precedence before and during any transition. Disable action is immediately effective. Restoration requires an independent two-person approval and append-only incident evidence. Unavailable custody services mean denial.

**Owner inputs required:** accountable custodian identities/roles, independent second approver, datastore and replication scope, operational switch API, out-of-band fallback, emergency escalation/incident SLA, recovery procedure.

## Mandatory integration and authorization gates

- **Policy locked? NO.** No H-RET/H-HASH/H-AUTH/H-TXN/H-KILL values or approval references were supplied to this block. The earlier seven principles stay approved.
- **Schema migration permitted? NO.** PR #296 design SQL cannot be promoted into a numbered migration; unapproved composite assignment keys, RLS predicate, privileges, hash anchor and control-state ownership remain.
- **Disposable PostgreSQL accepted? NO.** Required after schema and security ratification: migrated disposable DB with distinct admin/app/fixture roles, forced RLS tenant isolation, immutable UPDATE/DELETE/TRUNCATE refusals, revocation/independent approver, concurrency/idempotency and rollback, external digest/anchor verification, kill-switch priority and no CL learning/model/policy/BO writes.
- **Production shadow or Continuous Learning enabled? NO.** Separate deployment authorization is required regardless of migration outcome.

## Ratification procedure

For each H-* decision, record exact operational values, named reviewing authority, version, explicit owner approval reference, and disposition `RATIFIED`/`REJECTED`/`PENDING`. Owner decision records must be independently verified; a PR merge or locally asserted status is not approval. After all five are actually ratified, request a **separate** disposable-only migration implementation authorization and review the proposed SQL, permissions and audit writer in an isolated block. Stop on conflicts with source-of-truth ownership or the nine-layer guardrail.

**No new migration, role grant, DB connection, production flag or learning-release path is authorized by this specification.**
