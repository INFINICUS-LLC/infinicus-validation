# CL-ACT-06J — Security Policy Ratification & Migration Authorization Gate

Status: **RATIFICATION REVIEW MECHANISM IMPLEMENTED — NOT RATIFIED / NO MIGRATION AUTHORITY**.
Base main `22751a2300c92aa14915ab8d09f476ad463cb8c2` (PR #300 merged). Seven general shadow governance policies were previously owner-approved and remain preserved.

## Five decisions requiring exact owner ratification

- **H-RET:** Applicable jurisdiction and legal basis, exact retention period, deletion/redaction exceptions and litigation holds.
- **H-HASH:** Canonical byte encoding, hash algorithm domain separation/version, independent signed anchor custodian and verification/rotation cadence.
- **H-AUTH:** Canonical identity and ABA authorization read-port, grant/revoke policy, assigned database roles and composite tenant/workspace/business scope enforcement.
- **H-TXN:** Authoritative control state, idempotency scope and conflict behavior, transaction locking, atomic append and concurrency policy.
- **H-KILL:** Named emergency custodians, switch storage and recovery quorum, out-of-band shutdown and incident authority.

Owner has not yet given specific final settings or approval references for these five. The PR #300 recommendation text is not itself such ratification.

## Review contract

`ShadowSecurityRatificationGate.ts` provides a pure non-authorizing completeness review for one versioned ratification per decision, including nonblank approval reference. Missing, rejected, duplicate or incomplete entries are pending. Even five claimed ratifications yield `migrationAuthorized: false`; callers cannot self-grant migration authority through input records.

## Mandatory subsequent release conditions

1. Owner records actual H-RET/H-HASH/H-AUTH/H-TXN/H-KILL values, versions and explicit ratification under a controlled record.
2. Independently review with identity/ABA, database and security ownership; reserve migration number and resolve current candidate schema.
3. Implement a reviewed schema, canonical write port and forced RLS privileges **in a disposable migrated PostgreSQL instance first**.
4. Verify cross-tenant denial, append-only UPDATE/DELETE/TRUNCATE protection, canonical digest/anchor, atomicity, concurrency, revocation, kill switch and absence of learning/model/policy/BO mutations. Collect actual logs and query proofs; skipped tests fail acceptance.
5. Production deployment and live Shadow Mode require a distinct later approval. Production Continuous Learning stays disabled.

No migration, permission grant, production operation or database test has been performed by this block.
