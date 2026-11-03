# BO-PUB-DEV-02A-R1 — Conditional owner authorization and reconciliation

**Status:** POLICY DIRECTION CONDITIONALLY APPROVED; TECHNICAL CONTRACT NOT FROZEN; BO PUBLICATION NOT ACTIVE.
**Date:** 2026-11-01. **Baseline:** `32dba02681bb1d8386a91961c233ecc29cb5e7a4`.
**Evidence:** `docs/bo-record-publication-evidence.md`; `docs/bi-08-warehouse-load-validation.md`.
**Scope:** Review and specification only; no new executable behavior, migration, permission, or release activation.

## Owner's approved policy directions (conditional)

The owner explicitly accepted recommendations D1–D6 on 2026-11-01, **subject to technical verification**:

- **D1 — Identity:** Retain BO-specific proposed contract/schema/property names and `bo-canonical-json-v1`, CONDITIONAL on byte-identical producer/verifier/DB hashing and golden vectors.
- **D2 — Historical currency:** Refuse an evidence period containing a cost with unproven currency. Do not invent, omit, or reinterpret cost or currency; any backfill requires separate approval.
- **D3 — Granularity:** One immutable evidence artifact associated with each BO publication header and its half-open period, CONDITIONAL on lifecycle and count consistency verification. The header cannot move to dispatched until durable evidence is verified under an approved implementation.
- **D4 — Authority:** BO-owned service, explicitly authorized publisher and audit trail; existing approved role/permission should be reused only if demonstrated adequate. No new permission is approved here.
- **D5 — Scope:** Only inventory movements in v1. Other BO record domains require dedicated schema, tests and owner sign-off.
- **D6 — BI contract:** Validated exact-decimal TEXT preserving precision and scale, without binary floating-point coercion. An authorized scoped BO-evidence reader for BI requires separate implementation approval.

This is **not** permission to freeze an unverified contract, merge the PR, add a migration, activate publication or deploy.

## Technical reconciliation — findings and required closure evidence

### T1. Digest preimage MUST be unified — OPEN / BLOCKS FREEZE

Source documentation describes `SHA-256(canonical JSON excluding digest, evidenceId, provenance)`, while its proposed SQL constraint says `sha256(convert_to('bo-evidence-body:' || canonical_body, 'UTF8'))`. These are equivalent **only if** the producer's digest also includes the same ASCII prefix; this is not established from the documentation alone.

Before finalizing:
1. Inspect the actual pure producer/verifier source, derive exact UTF-8 preimage, field-ordering and string-escaping rules.
2. Decide whether a domain separator is part of the contract, based on implementation and security review; do not silently change existing digest.
3. Create golden vectors: empty record set; one record; UTF-8; equivalent decimal representation; record ordering; tampered record/count/scope/period; cross-implementation JS/SQL parity.
4. Assert exact byte equality of stored `canonical_body` with the hashed input in the approved contract.
5. Preserve backwards compatibility only if documented and approved; do not mark 0.1.0-proposed as active.

### T2. Record/body conservation MUST be transactional — OPEN / BLOCKS MIGRATION

Proposed SQL stores canonical text and separate `jsonb` record rows. A digest over the text cannot prove rows match it. Required: enforce `record_count`, contiguous positions `1..N`, body-vs-rows identity using a canonical verification routine, and atomicity at COMMIT. Specify hash verification semantics over serialized bytes and ensure denial of partial commits. Avoid treating PostgreSQL `jsonb::text` as equal to canonical JSON. Refuse truncated or mixed-scope evidence.

### T3. Artifact identity, replay, and lifecycle MUST be unique — OPEN

Specify the distinction between deterministic content-derived `evidenceId` and proposed random UUID row primary key. Model one durable artifact per header/period and exact replay idempotency; reject divergent content under the same header. Evaluate unique composite constraints and overlaps. Verify package state and count under an appropriate transaction and authorization, with a race-safe lock. Ensure publisher audit evidence is append-only and does not include prohibited sensitive source properties.

### T4. Source read consistency and historical records — OPEN

Specify a single coherent ledger snapshot for the half-open period; preserve ledger append-only semantics and maximum count handling. For periods with currency-unproven cost, reject the entire period under D2. Verify pre-0184 data immutability assumptions rather than extrapolating current append-only triggers retroactively. Define retention/erasure obligations before immutable evidence persistence.

### T5. BI-08 exact decimals and authorized reader — OPEN / BLOCKS INGESTION

Freeze a decimal-text field grammar with bounds equivalent to BO `numeric(18,4)`, canonical normalization and no float conversion. Confirm the BI-08 `number` type cannot be silently substituted for exact-decimal text. Read only verified evidence through a dedicated BO-owned scoped reader; no BI direct query of operational BO tables. Require lineage, record-count equality and end-to-end no-mutation tests.

## Evidence thresholds and stop conditions

Contract finalization requires: source-level producer/verifier comparison; reproducible golden vectors; candidate migration checked without applying; explicit append-only + forced RLS + transaction-bound tests on disposable PostgreSQL; scope/authorization proof; no critical mismatch; independent review.

These are **requirements**, not claims that these tests have run.

**No code, migration, deployment, activation, CI adjustment, production access, BO event emission, or movement to DEV-02B is authorized by this record.** Preserve frozen architecture and fail closed until each gate passes.
