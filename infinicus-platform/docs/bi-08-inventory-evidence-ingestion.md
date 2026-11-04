# BI-08-DEV-02 — Verified inventory movement evidence ingestion, warehouse insertion and sealing

Status: development candidate. No migration, no route, no permission, no activation. Publication on the BO side remains fail-closed (default authority denies), so no real evidence exists to ingest until the owner activates publication (open items G3/G4/G7 and the D3 dispatch gate).

## Pathway
BO ledger -> BO publication evidence (`bo.inventory_movements.record_evidence` 0.1.0-proposed, PROPOSED_NOT_ACTIVE; table `bo_publication_evidence`, migration 0224) -> BO read-only `InventoryMovementEvidenceReader` (re-verifies on read)
-> **BI consumer verification** (`bi08/inventoryEvidenceConsumer.ts`, pure) -> BI-08 validation and mapping (`BusinessIntelligenceWarehouseLoadPreparationService`, `existing: 'allow'`)
-> `BiWarehouseRowRepository.appendRows` (idempotent) -> `sealVersion` (database-computed; must equal the BO-declared count) -> BI-10 (reads sealed rows only).

## Service
`BusinessIntelligenceInventoryEvidenceIngestionService.ingest(ctx, businessId, { datasetVersionId, boPublicationPackageId })`. The request carries no rows, values or evidence. Evidence arrives only through the BI-side port `InventoryMovementEvidenceSource`
(in production the BO reader). `@infinicus/workflow` imports nothing from Business Operations (guarded). The service has no route.

## Independent verification (the port is not trusted)
Shape, contract identity/version/status, record schema, ordering, exact tenant/workspace/business scope on header and every record, publication header binding, count, exact property set of every record,
unique UUID movement ids, strict order (`occurredAt`, `movementId`), cost/currency present together, SHA-256 digest and evidence id re-derived from the canonical body.

## Exact decimals
BI-08 gains a `decimal` field type: canonical decimal TEXT (up to 14 integer digits, up to 4 fraction digits, no trailing zeros, no `-0`), exact min/max comparison via the BI-10 exact-decimal module. No floats anywhere.

## Idempotency and resume
Running again after a crash between batches, or after the seal, completes or confirms the same result and never overwrites: identical rows replay, different rows conflict (`INGESTION_CONFLICT`), sealing is idempotent.

## Closed result codes
`EVIDENCE_NOT_FOUND`, `EVIDENCE_INTEGRITY`, `EVIDENCE_REJECTED` (+ detail), `HEADER_MISMATCH`, `RECORD_COUNT_MISMATCH`, `LOAD_REFUSED` (+ detail), `INGESTION_CONFLICT`, `SEAL_REFUSED`. No value, SQL, schema or identifier text. An unknown or foreign dataset version raises the uniform `BiNotFoundError`.

## Verification
Unit: decimal 40, consumer 37, ingestion 10, architecture guards. Live PostgreSQL (application role): `apps/api/tests/bo-bi-inventory-pathway.integration.test.ts` (18 tests: real BO ledger rows -> BO publication -> BO reader -> ingestion -> seal -> BI-10 exact results; replay/resume; tamper; isolation; boundary statement spy).

## Remaining dependencies
Publication authority and activation (G4/G7), retention/erasure/repair (G3), D3 dispatch gate, a route/authority for triggering ingestion, other BO domains, completion-matrix refresh (not authorized).
