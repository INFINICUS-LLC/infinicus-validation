# BO durable inventory movement publication evidence (BO-PUB-DEV-02, aligned to the R4/D3 model)

Durable, BO-owned, immutable storage for the inventory-movement record evidence of BO-PUB-DEV-01, shaped exactly as the **R4/D3 association model** (`docs/production-readiness/BO_PUB_DEV_02A_R4_D3_INACTIVE_PERSISTENCE.md`). The contract is still the development candidate (`0.1.0-proposed`, `PROPOSED_NOT_ACTIVE`). **Publication is not activated**: no route, endpoint, event, audit row or permission; the shipped authority denies everything; the header-only dispatch path is untouched.

## Owner decisions this PR takes as given, and what stays open

The owner instructed "align #424 to the D3 model". That is read as accepting, **for this development PR only (disposable PostgreSQL; draft; unmerged)**:

| Gate (`BO_R4_D3_AUTHORITY_COMPATIBILITY_RECONCILIATION_20261103.md`) | Status in this PR |
|---|---|
| G1 one permanent slot per header | **Implemented** (`UNIQUE (publication_package_id)`, non-deferrable). Contract-version succession and historical headers are NOT designed: a second artifact for a header is a conflict. |
| G2 composite parent key, period/scope pinning | **Implemented** (`bo_publication_packages_d3_key`; FK on the six-column tuple, `RESTRICT`). Existing header writers audited by test: status/version/timestamps still update; scope and period of an *associated* header cannot. Historical-header and maintenance-role compatibility **not inspected** (no production catalog). |
| G3 canonical byte retention, provenance, retention/erasure, repair | Canonical bytes and first correlation retained. **Retention, erasure and privileged repair are NOT decided.** |
| G4 publisher permission, actor, revocation, business membership | **BLOCKED / unchanged.** The service is fail-closed; no permission is reused or added. |
| G5 isolated fixture-only harness | Superseded by a real numbered migration in this draft PR, per the instruction; the fixture harness of #423 still runs unchanged. |
| G6 acceptance matrix | **Executed here** against the constrained application role (see below). |
| G7 production migration / runtime publisher / audit / activation | **NOT authorized or done.** Migration 0224 is for disposable development databases only. |

Still true: the D3 dispatch gate ("a header cannot move to `dispatched` until durable evidence is verified") is **not implemented**; the existing header-only dispatch is unchanged and does not require evidence.

## Migration `0224_bo_publication_evidence.sql`

One table, one parent key. `bo_publication_evidence` is the single immutable association row holding the exact canonical body.

- **Slot and key:** `UNIQUE (publication_package_id)` alone; FK `(publication_package_id, tenant, workspace, business, period_start, period_end)` -> the same header tuple, `ON UPDATE/DELETE RESTRICT`, immediate. An association copied from another header, scope or period fails (`23503`).
- **Identities:** generated UUID row id; content-derived `evidence_id`; `digest = sha256('bo-evidence-body:' || canonical_body)` and `evidence_id = sha256('bo-evidence-id:' || contract || ':' || digest)` as CHECKs, so the stored bytes are exactly what was hashed. JSONB is never the equality reference.
- **Creation (defence in depth behind the writer):** header addressed to BI, in the creation state **`ready`** (not dispatched/received), declared count equal; columns agree with the body the digest covers. `created_at` is the database clock; the first correlation id is kept and ignored in content equality.
- **Append-only** (reuses `business_operations.forbid_mutation`), **ENABLE + FORCE RLS** (tenant+workspace policy). Business isolation inside a workspace is the explicit business predicate of every statement and of the composite keys; the header policy itself still has no business predicate (G4).
- No audit/outbox/dispatch insert; the header is never updated. No numeric/float column: decimals stay canonical text.

## Components

- `BoPublicationEvidenceRepository` (database): one transaction on one connection; business check; header locked `FOR UPDATE` by exact scope and id **first**; the association read **second**; an exact replay is returned **before** eligibility (so it still replays after the header advances); different content is a sanitized `CONFLICT`; a new association needs `ready` + BI; `INSERT ... ON CONFLICT (publication_package_id) DO NOTHING`, with a lost race read back separately and validated identically; database refusals are outcomes (never SQL/constraint text).
- `InventoryMovementEvidencePublicationService` (BO runtime): authority (only an explicit `true`) -> existing extractor (ledger snapshot, header agreement, currency provenance D2) -> verify -> store -> read back through the verifying reader.
- `InventoryMovementEvidenceReader` / `PublishedInventoryMovementEvidenceReader` (BI-ready, **read-only port**): rebuilds the artifact from the stored canonical bytes, requires them to be the canonical form, checks the stored columns against the body, re-derives digest and id and runs the complete verifier. Anything else is `STORED_EVIDENCE_INTEGRITY`. It never reads the mutable ledger.

## Acceptance matrix (executed on disposable PostgreSQL, application role)

First association; identical replay (new correlation, unchanged bytes/creation time/first correlation, replay after the header advances); concurrent identical (an **observed** lock wait on the header, then 8-way overlap); concurrent different content (one winner, one conflict, winner's bytes exact; direct duplicate `23505`); invalid metadata (body/identity/period/contract/digest/id each refused with zero writes; composite key `23503`); rollback with a waiting publisher; recovery from the stored association after the ledger changed (never regenerated; dispatched header without an association fails closed); tenant/workspace/sibling-business isolation with zero writes; FORCE/immutability catalog checks and non-owner, non-bypass role; parent-tuple pinning (UPDATE/DELETE refused, unrelated header changes allowed); integrity-on-read tamper detection. The header-only dispatch regression suite is the existing BO suite.

## Remaining dependencies (owner)

G3 retention/erasure/repair; G4 publisher authority (permission, actor, revocation, business membership, SQL role grants) — **required before any activation**; the dispatch gate and its audit/event convention; version succession and historical headers; production catalog/maintenance-role compatibility of the parent key; wiring the reader across the BO/BI package boundary; an exact-decimal BI-08 field type.
