# NEW-ARCH R0 — Web replacement programme and web architecture (owner decision record)

| Field | Value |
|---|---|
| Decision identifier | NEW-ARCH-R0-WEB-OPTION-B-2026-10-15 |
| Date | 2026-10-15 |
| Decision maker | INFINICUS owner (instruction given in the Claude Code session; recorded here by the engineering assistant) |
| **Status** | **APPROVED — decision only.** No implementation, deployment or cutover is authorised by it. |
| Basis | NEW-ARCH-01 readiness audit, findings G1 and G2 (this PR's companion report; HEAD `130bf5a`) |
| Not a signature | This record is not an electronic signature or a formally signed document. |

## 1. Decision
1. **Web architecture — Option B.** `infinicus-platform/apps/web` becomes a **client of the `/v1` HTTP API**. It authenticates through the Supabase sign-in and the server-verified identity exchange (`AC-3-J3-OPTION-B-2026-10-14`, conditionally approved), holds a backend-owned session, and sends it as a bearer token. It does not connect to PostgreSQL, and no cookie contract such as `inf_session` / `inf_workspace` is introduced to bridge identity.
2. **Programme.** Completing and testing the new modular web application is a named programme (the "web replacement programme"), run as separately authorised, independently verifiable blocks.

## 2. Why Option B (rather than keeping direct database access)
- One authentication path: the API's authenticate → tenant context → permission chain (pinned by `routePermissions.test.ts`) is the only route to data. Option A would keep a second path (database access with a cookie-carried session) next to the API.
- It matches the approved identity design: no browser-supplied authority, backend-owned sessions, server-side revocation on sign-out.
- The web server process needs no database credential.
- The audit found `apps/web` has no sign-in, no session issuer and no use of the API; nothing built there is lost by changing course before the sign-in layer exists.

## 3. Constraints that remain in force (not changed by this decision)
- Master Architecture Guardrail v1.0 (locked) is **not edited by this record**. §XVIII (Stack authority; no abrupt retirement of Stack A) applies in full: replacement exists, dependents migrated, source of truth proven, validation complete, rollback available, **explicit retirement authorisation**.
- Option B identity rules: no browser-supplied identity as authority; no HMAC or `SHADOW_ACCOUNT_SECRET`; frozen managed-account identifier; no password login or public registration for managed accounts; session revocation on sign-out and user switch; fail-closed behaviour; tenant / workspace / business boundaries enforced on the server.
- Guardrail §XXIII lists "new UI redesigns unrelated to first lifecycle" and "replacement of every legacy endpoint" among work *not required* to complete the current architecture programme, and §XXIV/§XXVII require each block to answer which §XXII criterion it closes. Per §XXV only the owner may amend the architecture. **The owner has now authorised this web programme; the locked guardrail text has not been edited.** A formal amendment or ledger entry, if the owner wants one, is a separate documentation decision.
- The legacy system is not disabled, retired, or de-prioritised for security or production-stability defects by this decision.

## 4. What this decision does NOT authorise
Implementation of any web block (including NA-04), changes to `apps/web` or `apps/api`, new migrations, deployment of `apps/web`, worker activation, production configuration changes, merging any PR, disabling or retiring the legacy application, declaring Criterion J closed, or starting NA-03 to NA-09. Each requires its own explicit owner authorisation.

## 5. Consequences recorded for the roadmap
- NA-04 (web authentication and API foundation) is now unblocked in principle by R0, but **NOT AUTHORIZED**. Its prerequisites include Option B being usable in practice (Gates A–D of the Option B record) and a decision on how `apps/web` will be hosted (it has no Dockerfile or deployment path today).
- The existing server-side direct-database code in `apps/web` (`lib/db.ts`, `lib/context.ts`, `lib/serverContext.ts`, server actions calling `@infinicus/workflow`) is a candidate for replacement by API calls; it is not to be extended in the meantime.

## 6. References
- Option B record: `docs/architecture/reconciliation/AC-3_OPTION_B_OWNER_DECISION.md` (draft PR #135 at the time of writing; not yet merged to `main`).
- Merged AC-3 work: PRs #129–#134 (`main` at `130bf5a`).
- Guardrail: `docs/architecture/MASTER_ARCHITECTURE_GUARDRAIL.md` §XVIII, §XXII–§XXVII.
