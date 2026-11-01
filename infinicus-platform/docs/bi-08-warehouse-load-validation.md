# BI-08 warehouse load validation and preparation (BI-08-DEV-01)

A pure validation-and-mapping foundation plus a verified, read-only preparation service. **It writes nothing.** The warehouse write boundary stays disabled because the authoritative source of records does not exist yet (see "Upstream publication decision"). No migration, route, permission or event was added.

## Discovery: what Business Operations actually publishes

- `business_operations.bo_publication_packages` holds a **header**: package code, target layer/block, period, `record_count`, a scalar `payload_reference` (`Record<string, string|number|boolean|null>`), a status.
- The frozen BO → BI contract (`handoff-contracts/src/bo-to-bi.ts`) states it "carries the intake reference only". `OperationalPublicationService` writes the header and a dispatch record; it carries no records.
- BI intake (`BoToBiIntakeRepository`) verifies the claimed header against BO's own record and stores a version with the **declared** record count; migration 0223 stores rows and seals them against that count.
- The frozen BI chain (BI-02 contract → BI-03 ingestion → BI-04 validation → BI-05..07 → BI-08 load) takes mapped records from a **source system**, not from the BO header.

Conclusion: **no approved record-level BO publication exists.** None was invented.

## What this block implements (frozen contracts)

| Frozen source | Implemented |
|---|---|
| BI-08 `WAREHOUSE-MODEL.md`: dataset type, grain, primary key fields, partition fields, load mode | `WarehouseDatasetContract`; grain enforced as uniqueness of the primary-key fields; partitions summarised |
| BI-07 → BI-08 `INTEGRATION-CONTRACT.md`: transformed records with a dataset contract id | `TransformedRecord` (`sourceRecordId`, `sourceIndex`, flat `fields`) validated against the contract |
| BI-04 rules: required, type, range, allowed values | enforced; failures refuse the load |
| BI-08 engine: grain validator, partition planner | grain uniqueness (collision-safe key), partition counts |

**Not implemented, fail closed:** BI-04 `pattern`, `referential` and `timeliness` rules (a contract naming them, or any unknown property, is `CONTRACT_INVALID`, so it never looks enforced when it is not); `replace` and `upsert` load modes (`LOAD_MODE_UNSUPPORTED`: a sealed version is immutable); quarantine (a sealed version must hold exactly the declared count, so any rejected record refuses the whole load).

## Deliberate differences from the frozen JavaScript

| Frozen | Here |
|---|---|
| grain key joined with `\|` (collisions possible) | JSON array of key values |
| `new Date(value)` accepts locale-dependent text | strict ISO `date` / `datetime` with real calendar validation |
| type check accepts any finite `number`, `Number.isInteger` | integers must be safe integers |
| empty primary key = no grain check | primary key required, and its fields must be required |
| records accepted with unknown fields | `FIELD_UNMAPPED` |
| quarantine and continue | refuse the whole load (seal needs the exact declared count) |

## Preparation service

`BusinessIntelligenceWarehouseLoadPreparationService.prepare(ctx, businessId, { datasetVersionId, contract, records })`:

1. resolves the target read-only (`BiWarehouseLoadTargetReadRepository`: SELECT-only, tenant/workspace/business pinned; the only BO table read is the publication **package header**);
2. verifies the chain: version published, intake `processed`, BO package addressed to BI and in a published state, exactly one source reference, no seal, no rows already held, and the **BO count equals the BI declared count**;
3. requires the offered records to equal the declared count;
4. validates and maps; on success returns `appendBatches` in the exact `AppendRowsInput` shape (split at `WAREHOUSE_APPEND_BATCH_MAX`), a deterministic `preparedLoadId` (version, source reference, BO package, contract hash, rows fingerprint) and `rowsFingerprint`.

Source identity is preserved inside every row (`__source_record_id`, `__source_index`; records may not carry `__` keys). Values are never defaulted, coerced or rounded; decimals should be supplied as strings (BI-10 reads them exactly). The database remains the authority for row fingerprints and the seal.

Refusals are a closed vocabulary of codes with positions and field names only, never a value.

## Upstream publication decision (outstanding, needs separate authorization)

Real records need an authoritative, record-level BO publication, or an approved BI-03 source connector. Questions for the owner: which BO domains publish record-level evidence; its schema and versioning; how it is signed or hashed so BI can verify integrity; whether records travel in the package, in a BO-owned evidence table BI reads, or via an event; and the dataset contract each domain maps to. Until that exists the next block (BI-08-DEV-02: ingestion, sealing and end-to-end BI-10 calculation) cannot be built on authentic data.
