# WORK-WEB-1: Staff assignments screen (read-only)

Workstream NEW-ARCHITECTURE-01. Layer: web presentation over Business Operations. Source of truth: Business Operations workforce assignments. Status: implemented, not deployed.

## Contract used (no backend change)

`GET /v1/businesses/:businessId/operations/workforce?limit=100` (existing; `bo:read`; tenant and workspace from the authenticated context; business must exist in the workspace, else 404; the API clamps `limit` to 1-100 and orders by start date, newest first). The screen is `/businesses/<id>/staff`, a new **Staff** tab. No new API, permission, table or migration.

## What the screen shows

One row per assignment exactly as Business Operations returned it: person (name and code), assignment (title and code), type, allocation, validity (UTC dates, or "from <date>, no end date"), and the server's own status.

- **Nothing is added up.** A person's allocation is shown per assignment; the screen never sums allocations or says whether a person is over- or under-allocated.
- **Nothing is judged against today's date.** The server's status is shown as sent; the screen does not decide what is current.
- **Honest about the bound.** At most 100 rows, newest first, with no total from the API; a full list shows a notice that more may exist.
- **Fails closed and read-only.** The response is validated on every read; a non-finite allocation is shown as unavailable; loading, error and empty states have the right roles; no button, form or input exists, and the screen says it does not hire, assign or change anything.

## Privacy note

The screen shows employee names and codes to whoever holds `bo:read` in the workspace, exactly as the API already returns them to that permission. It widens nothing: no new permission is introduced and no data the API does not return is shown. If the owner wants staff names restricted to a narrower permission, that is an authorization change on the API (a decision for the owner and the Core session), not a screen change.

## Evidence

- 17 unit/render tests (`client.workforce.test.tsx`): path and encoding, allocation and date formatting, open-ended validity, contract rejection, truncation, every view state, read-only, page guard; tab bar now ten screens; NA-05 guard allow-lists the page (11 tenant pages).
- Mutations killed: truncation threshold (2 tests), validity wording (2 tests), the finite-allocation check (2 tests).
- The web schema parsed the **real API response** (live PostgreSQL, application role, existing BUILD-32 seed) and re-serialised identically; it is shown as `100%` and `from 2026-10-01, no end date`. A temporary copy of the suite was used and not committed (the web package must not import API code).
- Web package 454/454, lint, typecheck, `next build` (route present), static-export check (10 required screens).

## Not in this block

Hiring, assigning or changing anyone, employee master data (the API does not return it and this screen does not redefine it), working hours, payroll, search or filter, pagination beyond 100 rows (needs an API change), and a browser run against a live API.
