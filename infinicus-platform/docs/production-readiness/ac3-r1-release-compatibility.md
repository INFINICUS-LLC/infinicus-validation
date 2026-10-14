# AC-3 Release Block R1 — compose configuration, sign-out revocation, and release compatibility

Status: CODE COMPLETE, NOT DEPLOYED. Nothing in this document has been executed against any real environment. Criterion J remains open.

## What R1 changes
| Defect | Change |
|---|---|
| R1-01: the API container never received `SUPABASE_URL` / `SUPABASE_ANON_KEY` | `hetzner/docker-compose.yml` and `oci/docker-compose.yml` pass both to the `api` service only, as required interpolations (`${VAR:?…}`): Compose refuses to resolve the stack when either is unset or empty. No default, no development fallback, no value committed. Names documented with empty placeholders in both `.env.example` files. |
| R1-02 (F6): browser sign-out left the backend session valid for 24 h | The page revokes the backend session (`POST /v1/auth/logout`) before `SUPA.auth.signOut()` in `signOutEngine()` and `signOut()`, again on the `SIGNED_OUT` event, and when a different Supabase user becomes active. Local state is removed first and unconditionally; a failed revocation is recorded in `lastBackendRevocation` and reported on the console without any token; it is never reported as success. A sign-out or user switch during an in-flight exchange discards the late result and revokes what it created. |

Not changed: token format, 24 h server TTL, the exchange, `/v1/auth/logout`, managed-account derivation, authorization, migrations.

## Operator note: the new compose files are fail-closed on purpose
`docker compose` evaluates the whole file, so **any** compose command in that directory (including `docker compose run --rm tools` for migrations) now stops with `set SUPABASE_URL in .env` until both values are present in the VM's `.env`. Set them first. This is the intended guard against deploying an API that silently answers 503 on every sign-in.

## Browser/API compatibility matrix
"Old browser" = the page before PR #131 (derives a password, calls `/v1/auth/login` then `/v1/auth/register`). "New browser" = current `main` plus R1. "Old API" = before PR #131 (no identity-exchange route). "New API" = current `main`, with `SUPABASE_URL` and `SUPABASE_ANON_KEY` reaching the container.

| Browser | API | Result | User impact | Evidence |
|---|---|---|---|---|
| Old | Old | Works as today | none | pre-#131 behaviour |
| Old | New | **Backend access fails.** Login with the derived credentials is refused (401, managed domain), the fallback register is refused (400), the page surfaces its generic "Couldn't reach the operations service" state. Already-open old tabs lose backend access immediately because the old page logs in on every use rather than reusing a cached token | Operations, My Business, Twin, Decisions, Data Acquisition sections show the unavailable screen until the tab is reloaded onto the new page. Local simulation still works (the page falls back to the local engine). No lockout side effect: the refusal happens before any account lookup, so no counter is touched; each attempt does add a `failed_auth` audit row | `AuthenticationService.login` (managed-domain refusal), `ac3-j3-identity-exchange` tests, `finalize()` fallback in `index.html` |
| New | Old | **Backend access fails.** The old API has no `/v1/auth/identity-exchange` (404), so no backend session can be obtained | Same unavailable screens; sign-out works (the old API already has `/v1/auth/logout`) | route absent on old API |
| New | New (configured) | Expected final behaviour | none | `ac3-j3-identity-exchange`, `ac3-r1-managed-logout`, `bridge-session-revocation` tests |
| New | New (Supabase variables missing or not passed into the container) | Exchange answers 503 (closed). With the R1 compose files this is prevented at deploy time | Same unavailable screens | R1-01 |

**There is no deployment order that keeps both generations working at once.** Whichever side is deployed first breaks the other side's backend features until the second side follows. The only way to bridge the gap would be to keep password login enabled for managed accounts, which reopens J-3; that is deliberately not done.

## Safe sequencing (plan only; not executed)
1. Read-only checks first: what `infini-cus.com` currently serves (does the page source contain `inf_backend_account_v3`?), and the API build (`GET /v1/health` field `version`). **If the new page is already live (the static publish path is unconfirmed, finding B3), the system is already in "New/Old": deploy the API immediately and skip step 2's waiting.**
2. Put `SUPABASE_URL` and `SUPABASE_ANON_KEY` in the VM `.env` (no other change yet).
3. Deploy the API: `GIT_SHA=$(git rev-parse HEAD) docker compose up -d --build api` from the deployment directory (PostgreSQL and Caddy are not restarted; the API restarts in seconds).
4. Validate before the page changes: a made-up token gives 401 (503 means the variables did not reach the container); an authorized test identity gives 200; the session works; `POST /v1/auth/logout` gives 204; the same token then gives 401. Requires an approved test identity (outstanding, B4).
5. Publish the page immediately after step 4. The window between steps 3 and 5 is the "Old/New" row above; keep it to minutes and choose a low-traffic time.
6. Verify sign-in, sign-out (check the session is dead server-side), user switching, and that an existing tenant is still reachable. Watch `failed_auth` events and 5xx for 24 h.

Maintenance window: not required for correctness; recommended for the few minutes between steps 3 and 5, with a short notice that open tabs need a reload.

## Rollback
Roll back the page and the API together, in quick succession (a mismatched pair is broken either way). Page: restore the previous static deployment. API: check out the previous commit (this also restores the previous compose file, so the extra `.env` values are simply ignored) and rebuild the `api` service. No migration or data change is involved, and backend sessions remain valid across versions.

**Rollback consequence to accept or avoid:** a user who was created *for the first time* by the new exchange during the window has an unusable password hash. After a rollback the old page cannot sign that user in (its login fails and its register fallback hits "already exists"). Accounts that existed before the release keep their old credentials and are unaffected. Keeping the window short limits this to new sign-ups; repairing such accounts would be a data change and is out of scope.

## Residual items (not R1)
Superseded sessions are not revoked when the page replaces a cached token after its 10-minute client life (revoking mid-poll would break in-flight calls); they live to the 24 h server expiry (F7). Session token still lives in `sessionStorage` (F1); `script-src` permits inline script (`'unsafe-inline'`), so XSS hardening is a separate package.
