# BI-09 governed metric registry — read API (BI-2-DEV-03)

Read-only access to the governed metric and KPI definitions that Business Intelligence has registered (BI-2-DEV-01 rules, BI-2-DEV-02 persistence, migration
`0222`). Two `GET` routes. There is no create, update, delete or approval endpoint: registration and revision stay in
`BusinessIntelligenceMetricRegistryService`. Nothing is calculated here (metric evaluation is BI-10).

## Access

- Authentication required. Permission: `bi:read` (the existing permission; no new permission was added).
- Tenant and workspace come from the authenticated session. The `businessId` must belong to the caller's workspace.
- An id that belongs to another business, workspace or tenant, a Stage 2D (ungoverned) definition, or one that does not exist, returns the same `404`.
- Only **governed** definitions are visible. A metric's `domain` is the domain of its own dataset (`warehouseDatasetId`).

## `GET /v1/businesses/:businessId/bi/metrics`

Latest version of every governed metric of the business, ordered by `code` (then id).

| Query | Values | Default |
|---|---|---|
| `datasetId` | UUID of the dataset a metric is defined on | none |
| `status` | `active`, `deprecated`, `retired` | none |
| `timeGrain` | `day`, `week`, `month`, `quarter`, `year`, `all_time` | none |
| `limit` | 1–100 | 20 |
| `offset` | 0–100000 | 0 |

Unknown query parameters are refused (`400`). Response: `{ metrics: [...], limit, offset }`. Each item: `metricId`, `code`, `name`, `metricType`
(`base`, `derived`, `ratio`, `rate`, `target`), `aggregation` (`sum`, `count`, `count_distinct`, `average`, `minimum`, `maximum`, `median`, `first`, `last`,
or `null`), `unit`, `currency`, `timeGrain`, `status`, `governanceStatus`, `owner`, `version`, `warehouseDatasetId`, `domain`, `updatedAt`.

## `GET /v1/businesses/:businessId/bi/metrics/:metricId`

One governed metric at its latest version. Query: `versionLimit` (1–100, default 20). Response: the list fields plus `description`, `sourceField`,
`dependencies` (metric ids), `dimensions`, `filters`, `formula`, `target`, `thresholds`, `contentHash`, `createdAt`, and `versions`
(`version`, `contentHash`, `governanceStatus`, `timeGrain`, `createdAt`; newest first).

## Errors

`400` malformed id, unknown or out-of-range parameter · `401` no or invalid session · `403` missing `bi:read` · `404` business or metric not found in scope ·
`500` unexpected failure (a non-sensitive body: `{ error: { code, message, correlationId } }`; the underlying cause is not returned).

## Not provided

No write path, no approval workflow, no BI-10 calculation, no dataset contract id (the dataset table has none), no migration.
