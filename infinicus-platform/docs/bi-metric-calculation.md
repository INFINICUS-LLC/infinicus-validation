# BI-10 metric calculation foundation (BI-2-DEV-05)

The first executable BI-10 capability: the governed BI-09 calculation hand-off (BI-2-DEV-04) plus the warehouse rows of the datasets it names go in, a
deterministic, exactly calculated **run** comes out. Frozen sources: `layers/business-intelligence/blocks/INFINICUS-BI-10…/` (`CALCULATION-MODEL.md`,
`ARCHITECTURE.md`, `INTEGRATION-CONTRACT.md`, the calculation engines).

Where it lives: `packages/workflow/src/bi10/` (`exactDecimal.ts`, `metricCalculation.ts`; pure) and
`packages/workflow/src/BusinessIntelligenceMetricCalculationService.ts` (read-only composition). BI-10 sits in its own folder so the BI-09 rules module keeps its
boundary ("BI-09 defines metrics, BI-10 calculates them"). **Not provided in this block:** persistence of results, an API route, events, the BI-11…BI-18
hand-off, a warehouse row source. Those need decisions and, for persistence, a migration (see the end).

## Pipeline

1. **Hand-off** — `BusinessIntelligenceCalculationHandoffService` (scoped, SELECT-only, approved + active metrics only). The calculation re-checks it: ready,
   BI-10 target, complete scope, every metric of that scope and approved + active, versions consistent, and **the hand-off id recomputed from its content must equal
   the id it carries** (an altered hand-off is refused).
2. **Validation of every definition before any value is calculated** (nothing partial is ever returned).
3. **Dependency order** (dependencies first, ties by code); unknown dependency and cycle are refused.
4. **Rows** — one `WarehouseRowSource.rows(scope, warehouseDatasetId)` call per base-metric dataset, with the hand-off's own scope.
5. **Base metrics**: filter → group (dimensions + time grain) → aggregate. **Derived / ratio / rate / target** from dependency results, per group.
6. **Targets and thresholds** → run with deterministic ids and the provenance below.

## Numbers

All arithmetic is exact (BigInt coefficient + scale). A JavaScript number enters as its shortest round-trip text (`0.1` is `0.1`); numeric text such as `"10.10"`
is accepted; booleans, non-finite numbers, padded text and objects are not numeric and are refused. Sum, difference, product, minimum, maximum, median and comparisons
are exact for any magnitude (`0.1 + 0.2 = 0.3`; `9007199254740993 + 1 = 9007199254740994`; `115.4 − 115.3 = 0.1`). **Division is the only rounding**: 10 decimal
places, round-half-to-even (`1/3 = 0.3333333333`, `2/3 = 0.6666666667`, exact ties go to the even digit). Rate is `(numerator × 100) / denominator`, rounded once.
Values are canonical decimal text (no exponent, no trailing zeros, no `-0`), or `null` when there is nothing to calculate.

## What is calculated (parity with the frozen engines; checked by a guard against the frozen source)

| | Supported |
|---|---|
| Aggregations | `sum`, `count`, `count_distinct`, `average`, `minimum`, `maximum`, `median` (mean of the two middle values for an even count), `first`, `last` (source order) |
| Filters (base metrics) | `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `not_in`, `contains`; shape `{ field, operator, value }`; numbers compare exactly, never across types |
| Time grains | `day`, `month`, `year`, `all_time` (UTC; `formula.timeField`, default `date`; an absent or invalid date is the bucket `unknown`) |
| Dimensions | any row fields; an absent value is the group `unknown`; dimension order in the definition is irrelevant |
| Derived | `formula.operator` `add`, `subtract` (first minus the rest), `multiply`, `divide` (exactly two dependencies) |
| Ratio / rate | exactly two dependencies (numerator, denominator); a zero or missing denominator gives `null` |
| Target | the governed target; applies to every group of a metric that references it |
| Thresholds | `criticalBelow`, `warningBelow`, `criticalAbove`, `warningAbove`, `goodAbove` (frozen precedence), `targetDirection` (`above` default / `below`), exact comparison |

## Deliberate differences from the frozen JavaScript

Each makes a result exact or refuses what the frozen code silently guessed. They are internal to this implementation; no frozen file was changed.

| Frozen behaviour | Here |
|---|---|
| IEEE doubles | exact decimals |
| a missing dependency value counted as `0` in add/subtract | `null` result (`no_data`) — no number is fabricated |
| unknown filter operator ignored (record kept) | refused (`FILTER_INVALID`) |
| `week`/`quarter` (and any unknown grain) silently bucketed as all-time | refused (`TIME_GRAIN_UNSUPPORTED`) |
| base metric without a source field summed `1` per row | refused (`SOURCE_FIELD_REQUIRED`) unless it counts rows |
| `Number(value \|\| 0)` coerced garbage | refused (`VALUE_NOT_NUMERIC`) |
| `calculatedAt` from the clock; random ids | no clock, derived ids; the run carries the hand-off's stored source timestamp (`handoffSourceTimestamp`, D-C) |

Unit and dimension validation (new, frozen model is silent): `add`/`subtract` need every dependency in the metric's own unit and currency (`UNIT_MISMATCH`); a derived,
ratio or rate metric must group exactly like each non-target dependency (`DIMENSION_MISMATCH`); filters on a non-base metric are refused.

## Size limits (D-F)

The frozen BI-10 engine reads at most **100000 rows per dataset query**; the same limit applies here and a larger dataset is **refused whole** (`DATASET_TOO_LARGE`),
never truncated. The proposed 100-metric processing limit was **not** adopted: the frozen BI-09/BI-10 contracts state no metric-count limit, BI-2-DEV-04 hands a
registry over whole, and a limit that refuses a valid approved registry would be a new external contract. A metric count limit remains an owner decision; it
would have to be a refusal, not a truncation.

## Output (`CalculationRun`)

`calculationRunId` (derived from the hand-off id and the dataset fingerprints), `calculationHandoffId`, `warehouseSnapshotId` (null), `correlationId` (the request's),
`handoffSourceTimestamp`, `metricCount`, `datasets[]` (`warehouseDatasetId`, `rowCount`, `rowsFingerprint` = SHA-256 of the canonical rows, order included) and
`results[]` ordered by metric code then group. Each result: `metricResultId` (derived from run, metric, version and group), `metricId`, `metricCode`, `metricVersion`,
`metricContentHash`, `warehouseDatasetId`, `group { dimensions, timeBucket }`, `value`, `unit`, `currency`, `target`, `threshold { status, targetMet }`,
`sourceRowCount` (base metrics), `calculationStatus` (`completed` | `no_data`).

Sample (revenue and cost by month, margin = revenue − cost, margin rate = margin / revenue; rows `1200.50/400.20`, `800.25/350.10` in January, `300.10/100.05` in February):

| metric | 2026-01 | 2026-02 |
|---|---|---|
| revenue | 2000.75 | 300.1 |
| cost | 750.3 | 100.05 |
| margin | 1250.45 | 200.05 |
| margin_rate | 0.6249906285 | 0.6666111296 |

## Determinism and provenance

The same hand-off and rows give a byte-identical run, whatever the clock, the order the registry lists metrics in, or the request's correlation id (only the run's
`correlationId` differs). Different rows (or the same rows in another order) give a different run id and fingerprint; a new definition version gives a new hand-off
and run. Inputs are never modified.

## Isolation

The only source of metrics is the scoped hand-off (tenant, workspace, business from the authenticated context; a foreign business is `NotFound` before any row is read).
The row source is asked only for datasets of base metrics in the hand-off, with the hand-off's scope; a failure reading rows is reported as
`DATASET_ROWS_UNAVAILABLE` and its cause is never returned. The calculation reads the registry tables only: no write statement, no Business Operations table,
no `metric_calculated_values` row.

## Remaining BI-10 functionality and what later blocks need

- **Warehouse row source.** Stack B has no warehouse row store: `analytical_dataset_versions` and `dataset_data_references` hold references and counts, not rows. An
  authorised source must be decided and built before a route can serve a calculation.
- **Result persistence** (frozen step 9): needs tables for calculation runs and metric results (or an owner decision to use the existing
  `metric_calculated_values`, which has no run/handoff/group-key/hash columns), versioning and idempotent replay keyed by `calculationRunId` / `metricResultId`. Migration required.
- **API route and permission** for executing a calculation and reading runs/results; **time grains** `week` and `quarter` (in the persisted vocabulary, not in the
  frozen grouping); **BI-11…BI-18 intelligence hand-off**; **warehouse snapshot** reference (D-A); a **metric-count limit** (D-F).
