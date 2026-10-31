# BI-09 → BI-10 calculation hand-off — read API (BI-2-DEV-04)

The governed metric definitions that Business Intelligence calculation (BI-10) receives, read from the registry that BI-2-DEV-01/02 built and BI-2-DEV-03
exposes. One `GET`. The hand-off is **derived** from the stored registry on every call and is **not stored**: there is no create, publish, update or delete
endpoint, no migration, and nothing is calculated here (metric evaluation is BI-10).

Frozen contract (`layers/business-intelligence/blocks/INFINICUS-BI-09…/docs/INTEGRATION-CONTRACT.md`, "BI-09 to BI-10"): calculation handoff ID, metric
definitions, metric versions, dependencies, dimensions, filters, units, targets, warehouse snapshot ID, correlation ID.

## Access

- Authentication required. Permission: `bi:read` (the existing permission; none was added).
- Tenant and workspace come from the authenticated session. The `businessId` must belong to the caller's workspace and not be soft-deleted.
- Authentication and `bi:read` are checked first: a caller without `bi:read` gets `403` whether or not the business exists.
- A business, metric id or selection outside the caller's scope returns the same `404` as one that does not exist.

## `GET /v1/businesses/:businessId/bi/metric-handoff`

| Query | Values | Default |
|---|---|---|
| `metricIds` | repeated UUIDs (either letter case); de-duplicated; order irrelevant | every approved, active metric of the business |

Unknown query parameters are refused (`400`). No tenant, workspace, snapshot, correlation or paging parameter is accepted.

Response `200`:

| Field | Meaning |
|---|---|
| `calculationHandoffId` | Deterministic identity (see below). |
| `targetBlock` | `BI-10`. |
| `businessId` | The business the hand-off belongs to (lower case). Tenant and workspace are not exposed. |
| `warehouseSnapshotId` | `null` in v1 (D-A). |
| `correlationId` | The request correlation id, unchanged (D-D). |
| `metrics` | The full definitions, ordered by `code`: `metricId`, `code`, `name`, `description`, `metricType`, `warehouseDatasetId`, `sourceField`, `aggregation`, `dependencies`, `formula`, `filters`, `dimensions`, `timeGrain`, `unit`, `currency`, `target`, `thresholds`, `owner`, `governanceStatus`, `version`, `status`, `createdAt`, `updatedAt`. |
| `metricVersions` | `{ metricId, version }` per metric, in the same order. |
| `status` | `ready`. |
| `createdAt` | UTC time (D-C, see below). |

### Selection rules (frozen, unchanged)

Only metrics that are `active` **and** `governanceStatus = approved` are handed over, each at its latest version. A metric whose dependency is not part of the
hand-off is refused. A metric named explicitly must meet the same rules (the frozen engine let an explicit list skip the approval check; the frozen architecture
says only approved metrics reach BI-10). Stage 2D (ungoverned) definitions are never visible. The stored header status and time grain are authoritative.

## Contract resolutions (D-A … D-F)

| | Resolution | Evidence |
|---|---|---|
| **D-A** warehouse snapshot | `null`. The Stage 2D schema has no warehouse-snapshot record, so none exists to reference and none is invented. The caller cannot supply one. | no snapshot table; schema accepts no snapshot input |
| **D-B** identity | A version-5-style UUID: SHA-256 over `{kind, tenant, workspace, business, targetBlock, warehouseSnapshotId, [metricId, version, contentHash]…}` (canonical JSON, metrics sorted). The same registry state gives the same id on every replay, in any request order, under concurrency. Any change to a handed-over definition, version, set, snapshot or scope gives a different id. The **correlation id and the clock are not part of it.** | `biCalculationHandoff.test.ts`, API replay/concurrency tests |
| **D-C** `createdAt` | **Discrepancy with the proposed default.** "First persisted creation time" requires a stored hand-off record; no hand-off table exists and creating one needs a migration, which is not authorized. `createdAt` is therefore the stored, immutable creation time (UTC) of the newest handed-over metric version. It never comes from a clock and is stable across replay; it changes only when the hand-off's content changes (which also changes the id). | API test compares it to `max(created_at)` in the database |
| **D-D** correlation | The request's own correlation id (`X-Correlation-Id` header, or the one the API generates), carried unchanged and echoed in the response header. It is request provenance, not hand-off identity, so a replay with another correlation id returns the same hand-off with that id. | API correlation tests |
| **D-E** errors | `400` invalid input · `401`/`403` authentication / `bi:read` · `404` unknown business or metric (own scope only, identical to foreign) · `409` metric not approved/active, dependency outside the hand-off, or nothing approved to hand over · `500` generic body (`internal_error`), underlying cause logged server-side only. Messages are fixed text; they never contain an id, code, SQL or tenant detail. | API error-mapping and 500 tests; guard on the mapping table |
| **D-F** size cap | **Open contract decision.** The frozen BI-09/BI-10 contracts state no size limit for a hand-off, and the read API's page bound (100) belongs to listing, not to this contract. No cap is applied: the whole approved registry is handed over (tested at 105 metrics). The practical request bound is the transport's URL/header limit for `metricIds`. The owner should decide whether a hand-off size limit (and a chunking rule for BI-10) is wanted before BI-10 consumes this. | service integration test (105 metrics) |

## Not provided

No hand-off table or persistence, no publish event, no approval workflow, no BI-10 calculation, no warehouse snapshot, no dataset contract id, no new
permission, no migration. Nothing in Business Operations, the Digital Twin or Simulation is read or written.
