# BI-10 warehouse row storage and calculation persistence (BI-2-DEV-07)

Durable, governed storage for BI-10: BI-owned **warehouse rows** of published dataset versions, and the **calculation runs and metric results** BI-10 produces from them.
Migration `0223_bi10_warehouse_rows_and_calculation_persistence.sql` (additive; development databases only until the owner authorises a shared environment).
There is **no route, no permission and no event** in this block: the execution API, run retrieval and result querying are BI-2-DEV-08.

## What exists, what was reused

| Need | Reused | Added |
|---|---|---|
| Datasets, versions, source references, declared record count | `analytical_datasets`, `analytical_dataset_versions`, `intelligence_source_references`, `dataset_data_references` (BI-1) | four scope keys (`UNIQUE (id, tenant, workspace, business …)`) so references can be composite |
| Metric definitions and versions | `metric_definition_versions` with the governed snapshot and `content_hash` (0222) | one scope key |
| Warehouse rows | none: `dataset_data_references` holds a reference and a count, not rows | `warehouse_dataset_rows`, `warehouse_dataset_version_seals` |
| Calculation runs and results | none usable: `metric_calculated_values` requires a value and a period (no `no_data` result), stores caller floats, and has no run, hand-off, group-key or definition-hash columns | `metric_calculation_runs`, `metric_calculation_run_inputs`, `metric_results` |

## Why a seal

Dataset versions are append-only and are created already `published` (`IntakeDatasetRepository`), carrying the record count Business Operations declared for the package.
"Immutable published evidence" therefore cannot be a draft-to-published transition. Instead rows may be appended to a published version until it is **sealed**:

- the database computes the seal (`row_count`, `declared_record_count`, `rows_digest`); the caller supplies only the version and cannot supply a count or a digest;
- it must equal the record count BO declared (`dataset_data_references.record_count`), and row numbers must run `1..n` without gaps;
- `rows_digest` is the SHA-256 of the row fingerprints in row order; a fingerprint is the SHA-256 of the row's `jsonb` text, computed by the database (independent of key order, never taken from the caller);
- after the seal nothing can be added (trigger), and rows, fingerprints and the seal are append-only;
- every read re-computes the digest from the stored row data and refuses (fail closed) if the rows no longer match their seal.

Every row cites a source reference of **the intake package its version was built from** (checked by a trigger), so rows are tied to the approved BO publication; nothing is read from mutable BO tables.

## Calculation persistence

A run is written in one transaction: run row, one input row per dataset (the sealed version the calculation read, with its row count and digest), and one row per result.
The database makes a run **complete or absent** (deferred check at commit: result count, input count, dataset fingerprints stated in the run equal those of its inputs, every base result's dataset was read).
Every result must agree with the stored definition version it cites (content hash, dataset, code, type) and every reference is a composite foreign key carrying tenant, workspace and business.
`persisted_at` is the database clock and cannot be supplied; `handoff_source_timestamp` is the stored source time of the BI-09 hand-off, kept separately (D-C).
`value` and `target` are `numeric`: the canonical decimal text round-trips exactly. A result with nothing to calculate is stored as NULL with status `no_data`.

`BusinessIntelligenceCalculationPersistenceService.persist` verifies **before** it writes:

1. the run accounts for itself (run id and every result id re-derived, values canonical, statuses consistent: the PR #409 gate `buildIntelligenceHandoff`);
2. each dataset input is a sealed, intact warehouse version of this business whose digest, row count and rows fingerprint are exactly what the run states;
3. the run is **reproducible**: the BI-09 hand-off it names is rebuilt from the registry and the calculation is repeated over the sealed rows; a run whose values differ is refused (`RUN_NOT_REPRODUCIBLE`). This closes the gap noted for the intelligence hand-off, where an altered value could not be detected.

Persistence is idempotent on the deterministic run id: the same run again is a replay and writes nothing; a different run under the same id is a conflict. A replay with another request correlation id returns the stored run: **the first correlation id is the provenance**.
`get` rebuilds the run from the tables and verifies ids and digest again (`STORED_RUN_INTEGRITY` if the store was altered behind the application).
`calculateAndPersist` calculates over the BI warehouse (`PostgresWarehouseRowSource`: sealed latest version, at most 100001 rows so an oversize dataset is refused, never truncated) and persists.

## Security and integrity summary

Forced row-level security on all five tables (tenant and workspace); explicit tenant, workspace and business predicates on every repository statement (business isolation inside a workspace depends on them alone);
composite scope-aware foreign keys; append-only (update, delete, truncate refused; the application role also holds no TRUNCATE privilege); sanitized errors (no schema, constraint or SQL text);
Business Operations tables are never read or written (statement-level test). Decimal row values should be stored as strings: a JSON number is a double once it leaves PostgreSQL.

## Not delivered (dependencies)

- **Row ingestion.** No BI ingestion pathway delivers rows yet, and no record-level BO publication contract exists. The storage and repositories are tested with clearly labelled development fixtures; production row flow is a separate dependency (BI-08 ingestion).
- **Execution API, run retrieval and result querying, permissions** (BI-2-DEV-08). **Events** and the BI-11…BI-18 publication of stored runs. **Time grains** `week`/`quarter`. A **metric-count limit** (D-F).
