# BO-PUB-DEV-02A-R3 — T2 transactional evidence conservation

**Status:** TECHNICAL CERTIFICATION PROBE; `PROPOSED_NOT_ACTIVE`. This record does not approve a durable migration, writer, reader, route, publication dispatch or contract activation.

**Baseline:** `8d0e65d2e26733a8468d6ceccfac48cc4b1dd74a` (merged R1 and R2).

The executable probe is `packages/business-operations-runtime/tests/InventoryMovementEvidence.transactional-certification.test.ts`. It uses the real BO producer and verifier. Its SQL exists only as temporary objects on one connection, except a uniquely named concurrent-insertion fixture in a dedicated disposable PostgreSQL database that is dropped after the test. No SQL is a repository migration.

## Verified T2 shape

- The exact producer canonical body is passed as text. A recursive SQL routine reconstructs its canonical JSON form; the deferred check compares the parsed body's ordered record array against every separately inserted `jsonb` row. It also checks the declared count, contiguous positions `1..N`, header/body/record scope, duplicate movement IDs, and natural record order (`occurredAt`, then `movementId`).
- The check executes at transaction close. Missing, skipped, duplicated, reordered, truncated, foreign-scope or altered records refuse commit; the entire header and all rows roll back.
- SQL hashes the exact stored canonical text with `bo-evidence-body:` and checks the derived `bo-evidence-id:` identity. Test vectors demonstrate PostgreSQL/TypeScript agreement for 0, 1 and 2 records, canonical decimal text, UTC microsecond timestamps and UTF-8 data.
- A concurrent duplicate insertion into a transient shared table permits one complete artifact and refuses the second with PostgreSQL unique violation; no partial child rows remain. The disposable database administrator creates and drops that fixture, granting the restricted application role only SELECT and INSERT on its two test tables; the application role does not receive schema CREATE.
- Mutation probes recompute a valid digest for duplicate or reordered content. Both the existing TypeScript verifier and the SQL conservation check reject it independently.

## Limits before a durable contract

This certifies a candidate conservation mechanism, not its deployment. The concurrent probe uses a separate transient shared fixture, not the future production table. A production migration still needs independently reviewed same-scope foreign keys, unique header identity, append-only protection, forced RLS, least-privilege grants, authenticated writer authority, explicit failure handling, and complete concurrency tests on the final schema. The SQL canonicalizer is evaluated against the proposed fixed ASCII property names and test vectors; it is not a general JSON canonicalization standard for arbitrary Unicode property names. T3 identity, replay, lifecycle and authorized publication remain open and require separate owner authorization.

## Local verification

- Focused T2/T1/producer: 114 passed across three files on disposable PostgreSQL 16.
- BO runtime suite without database credentials: 997 passed, 408 skipped (database-dependent cases).
- BO evidence architecture guard: 12 passed.
- Full workspace build: 30/30 tasks passed.
- Test typecheck: 0 new errors; 77 existing baselined errors.
- BO runtime lint: 0 errors, 4 pre-existing warnings. Changed test-file lint: 0 errors.

Hosted CI status and PR link are recorded in the owner completion report after GitHub runs.
