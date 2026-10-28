# DATA-WEB-1: Data sources and collection runs screen (read-only)

Workstream NEW-ARCHITECTURE-01. Layer: web presentation over Data Acquisition. Source of truth: Data Acquisition data sources and collection runs. Status: implemented, not deployed.

## Contracts used (no backend change; owned by the Data Acquisition runtime, consumed only)

- `GET /v1/businesses/:businessId/data-sources?limit=100` (existing; `da:read`)
- `GET /v1/businesses/:businessId/collection-runs?limit=100` (existing; `da:read`)

Both are tenant- and workspace-scoped from the authenticated context; the business must exist in the workspace (else 404); both return newest first. The screen is `/businesses/<id>/data`, a new **Data** tab. No new API, permission, table or migration. A person without `da:read` sees the existing "you do not have permission" sentence in the affected list.

## What the screen shows

- **Data sources:** name and description, code, type, sensitivity level, status, registered and updated times (UTC).
- **Collection runs:** the source's name (or a short id when the source list is unavailable), collection type, state, start and completion times (or "not started" / "not finished"), records received, accepted and rejected, attempt number, and the error code and message when there is one.

Rules the screen keeps:

- **Nothing is computed.** Record counts are shown per run as recorded; there is no total, no acceptance rate and no verdict that a run was good or bad.
- **Connectors are not read.** The screen does not call the connectors reads, so connector configuration references and the webhook token path (shown exactly once at generation, never retrievable) are never loaded.
- **Error text is data, not markup.** A run's error message is shown as escaped text.
- **Honest about bounds.** Each list is at most the 100 newest rows and the API gives no total; a full list shows a notice that more may exist.
- **Fails closed and read-only.** Both responses are validated on every read (a negative or non-integer count is refused); loading, error and empty states have the right roles; no button, form or input exists, and the screen says it does not import, register, retry or change anything.

## Evidence

- 15 unit/render tests (`client.dataAcquisition.test.tsx`): paths and encoding (and that no connector path is requested), time and label helpers, truncation, contract rejection, every view state, escaping of error text, read-only and no secret words, page guard; tab bar now twelve screens; NA-05 guard allow-lists the page (13 tenant pages).
- Mutations killed: truncation threshold (2 tests), non-negative count check relaxed (1), source-label fallback changed (2).
- Both web schemas parsed **real API responses** (live PostgreSQL, application role, the existing Data Acquisition integration suite) and re-serialised identically. A temporary copy of the suite was used and not committed (the web package must not import API code).
- Web package 494/494, lint, typecheck, `next build` (route present), static-export check (10 required screens).

## Not in this block

Registering or changing sources and connectors, manual intake, retrying a run, the per-run validation results, quality score and provenance reads (a later screen), connector health, and a browser run against a live API.
