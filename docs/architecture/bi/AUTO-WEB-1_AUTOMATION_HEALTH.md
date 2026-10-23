# AUTO-WEB-1: Automation health screen (read-only, administrators)

Workstream NEW-ARCHITECTURE-01. Layer: web presentation over Business Operations (execution health, L-OBS-1) and Outcome Monitoring (verification health, OM-OBS-1). Status: implemented, not deployed.

## Contracts used (no backend change; owned by other sessions, consumed only)

- `GET /v1/businesses/:businessId/execution-health` (existing; `bo:admin`)
- `GET /v1/businesses/:businessId/outcome-monitoring-health` (existing; `bo:admin`)

Both are tenant- and workspace-scoped from the authenticated context; the business must exist in the workspace (else 404). The screen is `/businesses/<id>/automation`, a new **Automation** tab. No new API, permission, table or migration; it does not call any recovery, replay or activation route. A person without `bo:admin` gets the existing "you do not have permission" sentence in the affected panel, not a partial view.

## What the screen shows

- **Action execution:** the service's status in words, the as-of time and window, claim counts (open, stranded, retry overdue, in progress), the oldest stranded age, a table of claims that need attention (action type, state, attempts, last attempt and reason code, overdue time, age), execution counts (succeeded, failed, refused; total and in window), the last execution time, and failed/refused executions by reason.
- **Outcome monitoring:** the service's status and attention reasons in words, verification counts, "verified business outcomes are not supported yet", missing-evidence counts, announced executions and the pending ones, failed verification attempts by code, dead letters (counts, by code, items), observation records by status, and the contracts' own `limitations`, always shown.

Rules the screen keeps:

- **Nothing is computed here.** No totals, rates or health verdicts of its own: the service's `status` is shown as sent (even `ATTENTION` with nothing listed). Reason, failure and dead-letter codes are shown as recorded, because their meaning is the service's.
- **Honest about bounds.** The service marks lists it cut short (`truncated`); a notice says more may exist.
- **Fails closed.** Both responses are validated on every read (an unknown status, attention reason or scope is refused); a negative or non-integer duration is shown as unavailable.
- **Read-only.** No button, form, input or select exists, and the screen says it does not retry, replay, recover or change anything.

## Evidence

- 25 unit/render tests (`client.automationHealth.test.tsx`): paths and encoding, duration and time formatting, status and reason wording, contract rejection, each panel's content, status shown as sent, truncation, an error in one panel not hiding the other, read-only, page guard; tab bar now eleven screens; NA-05 guard allow-lists the page (12 tenant pages).
- Mutations killed: status wording swapped (4 tests), duration boundary (1), negative duration accepted (2).
- Contract copies checked against **real API responses** (live PostgreSQL, application role): 9 responses from the existing execution-health integration suite and 15 from the existing Outcome Monitoring health suite all parse with the web schemas and re-serialise identically. Temporary copies of those suites were used and not committed (the web package must not import API code).
- Web package 479/479, lint, typecheck, `next build` (route present), static-export check (10 required screens).

## Not in this block

Retrying, replaying, recovering or activating anything, decision history and recommendations (existing screens), the approved-action and automation-policy reads, verified business outcomes (the Outcome Monitoring contract says it does not produce them yet), notifications, and a browser run against a live API. Core owns both contracts: if they change, the schemas here fail closed and the screen shows an unexpected-format message until updated.
