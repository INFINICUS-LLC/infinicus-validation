# AC-3 Block 4 — J-3 identity exchange and J-7 API-base lock

Status: IMPLEMENTED — owner approval of the design deviation (no HMAC secret) is PENDING. Criterion J is not closed by this block.

## What changed

| Gap | Before | After |
|---|---|---|
| J-3 | `index.html` derived the backend "shadow account" password from the Supabase user id (SHA-256) and kept it in `localStorage`. Anyone who learned a user id could log in as that backend user. | The page sends only its Supabase access token to `POST /v1/auth/identity-exchange`. The API asks Supabase to verify the token and derives the managed account from **Supabase's answer**. No password exists in the browser; managed accounts cannot log in with a password at all. |
| J-7 | `localStorage.inf_api_base_url` redirected every API call (and the bearer token) on the real site. | Honoured only on `localhost`/`127.0.0.1` and only for `http://127.0.0.1[:port]` / `http://localhost[:port]`. On the real site a stored override is removed and the default `https://api.infini-cus.com` is used. |

## API behaviour

* `POST /v1/auth/identity-exchange` body `{ "accessToken": "<20..8192 chars>" }` (strict: any other field is 400). Public route, rate limited to 20 requests/minute/client. Response shape equals `/v1/auth/login`.
* Verification: `GET {SUPABASE_URL}/auth/v1/user` with `apikey: SUPABASE_ANON_KEY` and `Authorization: Bearer <token>`, 5 s timeout. 401/403, a missing/invalid user id, or an unconfirmed email → 401. Network error, non-OK response or unreadable body → 503. `SUPABASE_URL` must be https (http only for loopback).
* Managed email = `shadow-<first 32 hex of sha256("infinicus-shadow-email-v2:" + providerUserId)>@infini-cus.local` — the **unchanged** legacy derivation, so existing accounts, tenants and businesses keep resolving to the same backend user.
* `register()` refuses the `infini-cus.local` domain (400). `login()` refuses it with the same 401 as any bad credential (audit `failed_auth`). New managed accounts get a random unusable password hash.
* A managed account that is not `active` is refused (403) and never silently reactivated; only `pending` is activated.

## Required API configuration (both are public values)

| Variable | Meaning |
|---|---|
| `SUPABASE_URL` | Base URL of the Supabase project used by the public site |
| `SUPABASE_ANON_KEY` | That project's public anon/publishable key (already shipped to browsers) |

If either is unset the route answers **503** and nothing is created (closed). No secret value belongs in this repository or in any page.

## Deployment order (treat as ONE release)

1. Deploy the API with `SUPABASE_URL` and `SUPABASE_ANON_KEY` set.
2. Verify: `POST /v1/auth/identity-exchange` with a made-up 20+ character token → **401** (not 503; 503 means the config did not load). With a real test user's access token → **200** and a working `rawSessionToken`.
3. Only then publish `index.html`.

Publishing the page before the API leaves the page's backend features failing (the old password login is already refused by the new API and the old API has no exchange route).

## Rollback

Roll back the API and the page together (previous API image + previous `index.html`). There are no migrations and no data changes: managed users created by the exchange are ordinary `identity.users` rows with the same email the old flow used.

## Known limitations / follow-ups

* `sessionStorage` is readable by same-origin script; the backend token is short-lived, revocable and not derivable from anything, but it is not a vault.
* `index.html` still persists the provider user id in `localStorage` key `infinicus_user` (low; pre-existing).
* A cached backend token that the API rejects (401) inside its 10-minute client-side window is not retried automatically (low).
* Legacy shadow accounts keep their old password hash (unusable because login is refused for the domain); rotating those hashes is out of scope.
* Legacy-id migration: ids carried over from the old browser record are bound to the first Supabase user who exchanges on that browser; a different user on the same browser would be refused by the API (403) when using them.

## Owner decisions pending

1. Approve Option B (password-disabled managed accounts, **no** `SHADOW_ACCOUNT_SECRET`/HMAC) — see the PR for the comparison.
2. Set `SUPABASE_URL` and `SUPABASE_ANON_KEY` in production (owner action).
3. **Unresolved question:** are `LEGACY_AUTH_API` and `LEGACY_BUSINESS_API` unset in production? Must be answered before J-4 is planned.
4. Schedule follow-ups for the low/medium findings above.
