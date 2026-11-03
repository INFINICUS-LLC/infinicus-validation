# BO durable inventory movement publication evidence (BO-PUB-DEV-02)

Converts the verified record-evidence foundation (BO-PUB-DEV-01, `docs/bo-record-publication-evidence.md`) into **durable, BO-owned, immutable, independently verifiable** storage. The contract is still the **development candidate** (`0.1.0-proposed`, `PROPOSED_NOT_ACTIVE`): schema, canonical serialization, identity, digest and provenance rules are unchanged. **Publication is not activated**: no endpoint, no route, no event, no permission; the shipped authority denies everything.

## Migration `0224_bo_publication_evidence.sql` (additive; disposable development PostgreSQL only)

| Object | Purpose |
|---|---|
| `bo_publication_packages_scope_key UNIQUE (id, tenant_id, workspace_id, business_id)` | lets evidence reference a header with its full scope (same pattern as 0223) |
| `bo_publication_evidence` | **one** immutable artifact per publication header (`UNIQUE (publication_package_id)`) |
| `bo_publication_evidence_records` | the ordered records (position 1..n, movement id, record `jsonb`) |

Identity (D3) is the canonical body the digest covers: tenant, workspace, business, publication header id, source domain, period, record schema version, record-set digest. The database enforces that every identity column agrees with that body.

**Database-enforced rules**
- `digest = sha256('bo-evidence-body:' || canonical_body)` and `evidence_id` derived from the digest (CHECK constraints): the stored body is the hashed text, verbatim.
- Header binding (before-insert trigger): the header is in the **same tenant/workspace/business** (composite FK), addressed to BI, in a published state (`ready`/`dispatched`/`received`), with the **same period** and **same declared record count**. The declared count is read from the header, never supplied.
- Complete or absent (deferred constraint trigger at commit): record count equals the declared count, positions run `1..n`, and the stored records **equal the canonical body's records**. Extra records cannot be added afterwards (position bound + primary key).
- Append-only: update/delete/truncate refused (reuses `business_operations.forbid_mutation`); forced tenant+workspace RLS; composite scope-aware keys. `created_at` is the database clock.
- Decimals are text: no numeric/float column exists; quantities and costs are canonical decimal strings in the body and the `jsonb` records.

## Components

- `BoPublicationEvidenceRepository` (database): atomic insert (one transaction, advisory lock per header, savepoint so a refusal is an outcome), **deterministic replay** (same digest stores nothing), **conflict** (different digest under the header), scoped read, sanitized outcomes (`STORED | REPLAYED | CONFLICT | REFUSED | UNKNOWN_BUSINESS`; never SQL/constraint text).
- `InventoryMovementEvidencePublicationService` (BO runtime): authority gate → existing BO extractor (ledger + header agreement + currency provenance) → verify → store → read back through the verifying reader.
- `InventoryMovementEvidenceReader` / `PublishedInventoryMovementEvidenceReader` (BI-facing, **read-only**): depends only on a `getByHeader` port; reads only the evidence tables (never the mutable ledger); verifies on every read: stored body = regenerated body, digest and evidence id re-derive, counts/positions agree, complete artifact verifier passes. Anything else is `STORED_EVIDENCE_INTEGRITY`.

## Rejections (closed codes, no values)

Foreign business/tenant header (`HEADER_NOT_FOUND`), wrong state (`HEADER_NOT_PUBLISHED`), wrong layer (`HEADER_NOT_FOR_BI`), period disagreement (`HEADER_PERIOD_MISMATCH`), count disagreement (`HEADER_COUNT_MISMATCH`), unproven historical currency (`EVIDENCE_REJECTED`, D2: never inferred, defaulted or backfilled), duplicate/conflicting evidence (`EVIDENCE_CONFLICT`, or replay), digest/record/identity mismatch at the database (`EVIDENCE_REFUSED`), unauthorised (`PUBLICATION_NOT_AUTHORIZED`).

## Authority (D4) and what is NOT activated

The existing model has `bo:read`/`bo:write` for API callers; there is no permission or caller context that establishes authority for durable publication, and none is invented. The service therefore requires an explicit `PublicationAuthority` (only `=== true` authorises; a throwing authority publishes nothing) and ships only `DisabledPublicationAuthority`. Nothing in production constructs an approving authority (architecture-guarded). **Activation dependencies:** an owner-approved authority/permission, a route or job that calls the service, the audit/event convention for publication, and the decision on when a header may move to `dispatched` (requires evidence?).

## BI-08 readiness

BI-08-DEV-02 can consume `PublishedInventoryMovementEvidenceReader` only; it must not read BO tables. Still open: wiring that reader across the BO/BI package boundary, an exact-decimal field type in BI-08 (quantities/costs are text), and activation of publication. Nothing here inserts warehouse rows or seals datasets.
