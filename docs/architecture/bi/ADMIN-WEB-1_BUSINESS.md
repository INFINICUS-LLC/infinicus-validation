# ADMIN-WEB-1: Business screen, declared currency (read-only)

Workstream NEW-ARCHITECTURE-01. Layer: web presentation over Business Administration. Source of truth: the declared-currency record (migration 0185). Status: implemented, not deployed.

## Contracts used (no backend change; consumed only)

- `GET /v1/businesses/:businessId/declared-currency` (existing; `bo:read`)
- `GET /v1/businesses/:businessId/declared-currency/history` (existing; `bo:read`)

The screen is `/businesses/<id>/business`, a new **Business** tab. No new API, permission, table or migration. Declaring or changing the currency (`PUT`, `platform:admin`) is not offered. The subscription read (`GET /v1/billing/subscription`, `platform:admin`) is tenant-level rather than business-level and is not used here.

## What it shows

- **Declared currency:** the code, version, declared time (UTC), whether it was the first declaration or a change from a prior currency, and the reason when given. A business that has not declared one is told so, with "No default is assumed."
- **Declaration history:** every declaration, oldest first.

## Rules the screen keeps

- Nothing is defaulted, converted or guessed; the code is shown exactly as returned.
- The current response is refused if its status and declaration disagree, and a provenance other than an explicit declaration is refused.
- A reason is shown as escaped text. No form, button or input exists; the screen says it does not declare or change anything.

## Evidence

- 11 tests in `client.businessAdministration.test.tsx`; tab bar now thirteen screens; NA-05 allow-list updated (14 tenant pages).
- Mutants killed: status/declaration check removed (1 test), first-declaration label inverted (2), provenance relaxed (1).
- Both web schemas parsed **real API responses** (live PostgreSQL 16, application role, the existing declared-currency integration suite, 3 current and 2 history reads) and re-serialised identically. A temporary copy of the suite was used and not committed.
- Web package 505/505, lint, typecheck and `next build` (route present).

## Not in this block

Declaring or changing the currency, business profile editing, subscription and billing views, branch and role administration (X-03, X-04), and a browser run against a live API.
