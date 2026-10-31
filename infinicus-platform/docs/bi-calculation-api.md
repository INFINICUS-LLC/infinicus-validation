# Governed BI-10 execution and results API (BI-2-DEV-08)

Three routes over the merged BI-10 foundation (BI-09 hand-off → exact calculation → sealed BI warehouse rows → verifying persistence, migration 0223). **No migration, no permission, no event and no new table was added.**

## Routes

| Method and path | Authority | Effect |
|---|---|---|
| `POST /v1/businesses/:businessId/bi/metric-calculations` | `bi:write` **and** `bi:read`, active subscription, `Idempotency-Key` | Calculates over the business's sealed warehouse versions and stores the run (201; 200 on replay) |
| `GET /v1/businesses/:businessId/bi/metric-calculations/:runId` | `bi:read` | One stored run with its sealed dataset provenance. No mutation |
| `GET /v1/businesses/:businessId/bi/metric-results` | `bi:read` | Stored results, newest run first, filtered and paginated. No mutation |

## Execution permission resolution

Execution writes a run, so `bi:read` alone never authorises it. The frozen RBAC model already seeds `bi:write` ("Manage business intelligence analyses and metrics", migration 0137); execution requires it together with `bi:read`. A dedicated execution permission (for example `bi:execute`) would need a migration and was not authorised; it remains an owner decision.

## Execute

Body (strict, optional): `metricIds` (subset of approved, active metrics; default all) and `calculationHandoffId` (the hand-off the caller expects; a different current hand-off is refused with 409 `HANDOFF_CHANGED`, nothing calculated). **Rows cannot be sent**: unknown body fields are rejected, and rows are read only from the business's sealed warehouse versions through `PostgresWarehouseRowSource` (verified against row counts and fingerprints, at most 100000 rows per dataset, oversize refused whole).
No sealed data, an unsealed or altered version, or an unavailable dataset fails closed (409). The response is the run summary and the sealed provenance of each dataset; results are read through the results route (the frozen API returned them inline: documented deviation to keep the response bounded).

Idempotency has two layers: the platform `Idempotency-Key` (same key and body replays the stored response; same key with another body is 409), and the deterministic run id (a new key for the same hand-off and rows returns the stored run with `replayed: true`; the first correlation id is kept).

## Results query

Filters: `calculationRunId`, `metricId`, `metricCode`, `calculationStatus`, `thresholdStatus`, `timeBucket`. `limit` 1–100 (default 50), `offset` 0–100000. Ordering is total (`persisted_at` desc, run, code, group key, id) so pages are deterministic. Values and targets are canonical decimal text. Each result carries identity, metric version and content hash, unit, currency, group, time bucket, target and threshold status, source row count and the sealed dataset version (lineage). Invalid filters are 400; a business or run of another party is indistinguishable from a missing one (404).

## Security

Authenticated, tenant/workspace from the context, business verified in scope; forced row-level security plus explicit tenant/workspace/business predicates on every statement; SELECT-only read repository with bound parameters; errors drawn from a closed vocabulary (404, 409, generic 500) with no SQL, schema or cause text.

## Not delivered (dependencies)

- **BI-08 governed row ingestion** from authoritative Business Operations evidence is **outstanding**: no production rows exist, so the execute route fails closed in any environment where nothing has been ingested and sealed. Tests use labelled development fixtures only. Nothing in the routes can create rows.
- Time grains `week`/`quarter`, events and BI-11…BI-18 publication of stored runs, a metric-count limit (D-F), and a dedicated execution permission.
