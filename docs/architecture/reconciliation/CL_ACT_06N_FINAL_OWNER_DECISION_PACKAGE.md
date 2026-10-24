# CL-ACT-06N — Final Technical Policy Decisions & Owner Approval Package v1

**Status:** READY FOR EXPLICIT OWNER DECISIONS — NOT RATIFIED.  
**Date:** 2026-10-24  
**Base main:** `37f2698bed6802a3efd1cd504c1de648456c8bdc`.  
**Dependencies:** PR #302 (ratification record) and PR #304 (readiness assessment) were open during this block. Do not mistake these open draft artifacts for approved policies or database acceptance.

## Approved owner constraints (unchanged)

1. Identity/ABA alone issues explicit `cl:shadow:evaluate` authority; no `bo:admin` inheritance.
2. Independent human approval; no delegation.
3. Shadow defaults OFF; emergency kill switch overrides any authorization.
4. CL owns shadow audit facts; ABA owns grants/assignments.
5. No automatic audit deletion until retention policy is approved.
6. Stale/revoked authority immediately refused on canonical recheck.
7. Advisory shadow only; no CL release, model/policy updates, or BO mutations.

## Ratification decisions — owner must explicitly approve or amend each

### H-RET — Retention and privacy
**Proposed:** Store minimal structured audit metadata and cryptographic digests, not raw customer records, access tokens or financial payloads; prohibit automatic purge pending a jurisdiction-specific privacy review and recorded retention schedule. Design legal-hold and erasure-compatible linkage.
**Owner must set:** controlling entity and governing jurisdiction(s), lawful basis, concrete record retention duration(s), exceptions/holds, data-subject request procedure and accountable privacy reviewer.
**Disposition:** PENDING; no duration or jurisdiction assumed.

### H-HASH — Cryptographic integrity
**Proposed:** Trusted-writer-generated canonical UTF-8 digest, explicit version/domain separator, ordered per-control chain, SHA-256 integrity, independent off-database head anchoring signed by a custody-separate key owner.
**Owner must set:** canonical serialization specification, stream identity, key provider/owner and access roles, anchor cadence, external anchor store, key rotation and disaster-recovery proof.
**Disposition:** PENDING; this is not yet cryptographically ratified.

### H-AUTH — Identity, scope and privileges
**Proposed:** Verified platform principal and ABA-issued exact scoped permission/version/provenance, independent human approver, no delegation. CL audit writes only through narrowly restricted function/port enforcing composite tenant/workspace/business scope and database-time authority; FORCE RLS for app roles.
**Owner must set:** exact identity/ABA issuer and read API, grant/revoke representation, role/GRANT matrix, session claim trust mechanism, security-definer safeguards, composite FK decisions.
**Disposition:** PENDING; no privilege granted.

### H-TXN — State, idempotency, concurrency
**Proposed:** CL-owned default-disabled control row, serialized control/version lock, atomically append one immutable audit event and control change, key exact replay by tenant/workspace/business/control/operation/idempotency key and reject changed payload; rollback all on audit failure.
**Owner must set:** authoritative control-state schema, lock ordering and isolation, event sequence and key scope, serialization format, retry/conflict rules and revocation-race semantics.
**Disposition:** PENDING; no write port enabled.

### H-KILL — Emergency custody
**Proposed:** Fail-closed switch always overrides permissions and remains default blocking; independently approved two-person recovery with append-only audit evidence; emergency revocation takes effect before next evaluation.
**Owner must set:** named emergency custodians and recovery approver roles, switch storage/replication, fallback channel, incident process and SLA, escalation path.
**Disposition:** PENDING; no operational custody delegated.

## Decision record format and acceptance standard

For every ID, record **approved operational values**, specification version, explicit owner approval reference and date, named database/security reviewer, and disposition (RATIFIED/REJECTED/PENDING). The approved values must be sufficient to implement and independently test; broad consent to development or merging this package does not qualify.

The previous owner's seven decisions are already binding; ratifying these five is separate. **The user requesting CL-ACT-06N is not itself ratification.**

## Migration authorization sequence

1. Obtain and independently verify exact H-RET/H-HASH/H-AUTH/H-TXN/H-KILL owner approvals.
2. Reconcile #296 DDL with composite ABA/tenant scopes, authoritative write port, atomic control state, security grants, canonical digest and protected anchoring; choose reviewed numbered migration.
3. Obtain **separate disposable-only implementation authorization**; execute PostgreSQL migrations and negative RLS/role/immutability/concurrency/revocation tests on a newly provisioned nonproduction DB.
4. Record actual PostgreSQL version, schema digest, SQL role grants, CI and all negative-case test evidence. Skipped tests do not pass.
5. Production migration, live shadow and Continuous Learning require **separate** explicit authorization and further positive outcome authority gates; not part of this package.

**Current readiness:** NOT RATIFIED / MIGRATION NOT AUTHORIZED / NO POSTGRES ACCEPTANCE / LIVE SHADOW OFF / PRODUCTION CONTINUOUS LEARNING OFF.
