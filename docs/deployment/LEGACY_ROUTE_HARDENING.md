# Legacy Pages route hardening (PR-C)

Status: implemented on top of PR #53 (shared guards). No schema, migration, Stack B, Cloudflare, DNS or deployment change. Not safe to launch until the blockers at the end are closed.

## What changed
| Route | Before | After |
|---|---|---|
| `nurture-batch` | bearer checked **only if** `NURTURE_BATCH_SECRET` was set; wildcard CORS | bearer **mandatory** (secret >= 32 chars, constant-time compare); unset/weak secret = 503; no CORS; email only via `email.js`; nothing marked "sent" unless really sent |
| `nurture` | unauthenticated; could email any address | same mandatory bearer; strict body; email only via `email.js` |
| `simulate` | wildcard CORS; optional key (fail open, unusable by a browser); in-memory limit | exact-origin allowlist; bounded body; strict nested validation; KV abuse limits (10/h per IP, 3000/day global); `ANTHROPIC_API_KEY` required; `INFINICUS_API_KEY` removed |
| `waitlist` | wildcard CORS; unescaped HTML; mails the submitted address | exact origin; strict fields; escaped HTML; limits; signup still stored; mail only per email policy; response still `{ok:true}` |
| `feedback` | wildcard CORS; unescaped comment in owner mail | exact origin; strict fields; escaped; limits; owner mail only per email policy |
| `parse-idea` | wildcard CORS; trusted client MIME type; leaked internal error text | exact origin; limits; 5 MiB cap; image type from magic bytes; generic errors |
| `send-email` | wildcard CORS; any recipient; unescaped HTML; pages.dev sender | **disabled by default**; exact origin; strict fields; escaped; fixed subjects; limits incl. 3/day per recipient; configured verified sender |
| `/api/business/**` | open, unauthenticated, wildcard CORS | **default-deny 404** via `_middleware.js`; route files unchanged |
| `/api/auth/**` | open, unthrottled, wildcard CORS | **default-deny 404** via `_middleware.js`; route files unchanged |

New shared files: `functions/_shared/route.js` (ordered gate composed from the PR-B primitives) and `functions/_shared/email.js` (email policy). Nothing from PR-B is re-implemented (a test enforces it).

Gate order: configuration -> preflight -> method -> exact Origin (browser routes) or bearer (server routes) -> abuse limits -> bounded body -> field validation. Every failure is a generic body from a fixed table; every denial writes one `{event, route, code, status}` log line with no request data.

## Not authentication
Exact-Origin checks, rate limits (best-effort KV counters, eventually consistent, refused as a security boundary by the code) and the future Turnstile are abuse and cross-site controls. They do not identify or authorise anyone. Only the server routes authenticate (bearer secret). No route here models a user, tenant or session.

## Configuration (names only; values are set by the owner in the target Pages project)
| Name | Needed by | If missing or invalid |
|---|---|---|
| `ALLOWED_ORIGINS` (comma list of exact https origins) | all browser routes | 503 `unconfigured:allowed_origins` |
| `INFINICUS_WAITLIST` (KV binding) | all limited routes, waitlist, nurture-batch | 503 `unconfigured:infinicus_waitlist` |
| `INFINICUS_USERS` (KV binding) | feedback storage | 503 |
| `NURTURE_BATCH_SECRET` (>= 32 chars) | nurture-batch, nurture | 503 `unconfigured:nurture_batch_secret` |
| `ANTHROPIC_API_KEY` | simulate | 503 |
| `EMAIL_MODE` = `disabled` (default) / `log` / `live` (exact, case-sensitive; anything else = disabled) | all email | nothing is sent |
| `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_VERIFIED_DOMAINS` | live email | live refuses to send (`unconfigured`) |
| `EMAIL_OWNER_TO` | owner notifications | owner mail not sent |
| `EMAIL_REPLY_TO`, `EMAIL_ALLOWED_RECIPIENT_DOMAINS` | optional | n/a |
| `LEGACY_BUSINESS_API`, `LEGACY_AUTH_API` (`enabled` exactly) | compatibility review only | route family answers 404 |
| `SIMULATE_*`, `WAITLIST_*`, `FEEDBACK_*`, `PARSE_IDEA_*`, `SEND_EMAIL_*` per-hour/per-day overrides | optional | code defaults |
| `AI` binding | parse-idea | documented fallback answer |
Do not set `INFINICUS_API_KEY` (no longer read) and do not set `LEGACY_*` flags until the compatibility and identity-authority review has happened.

## Email policy
`disabled` sends nothing and needs no secret. `log` rehearses (one fixed log line per message, no address or content). `live` requires a strong `RESEND_API_KEY`, `EMAIL_FROM` whose domain the owner has attested in `EMAIL_VERIFIED_DOMAINS` (`*.pages.dev`/`*.workers.dev` refused), and, for owner mail, `EMAIL_OWNER_TO`. Exactly one strictly validated recipient per message; owner mail goes only to `EMAIL_OWNER_TO`; the sender is never a recipient; subjects are flattened to one line; sender and reply-to come only from server configuration; provider responses are never returned or logged.

## Frontend compatibility (documented, not hidden)
Calls found in `index.html`, `account.html`, `landing.html`:
| Call | Result with this PR |
|---|---|
| `POST /api/simulate` (index) | Works; payload accepted unchanged (test replays the real shape). Requires `ALLOWED_ORIGINS`, KV counters and `ANTHROPIC_API_KEY`; any non-200 already falls back to the static analysis. Hourly cap of 10 per IP is unchanged. |
| `POST /api/waitlist` (index) | Works; response unchanged. Owner/welcome emails are **not sent** until live mode. Stored emails are lower-cased. |
| `POST /api/feedback` (index) | Works; response unchanged; owner email only in live mode. Comments with control characters are now rejected (fire-and-forget, user sees no change). |
| `POST /api/parse-idea` (index) | Works for real JPEG/PNG/GIF/WebP up to 5 MiB; others get a generic 4xx (UI already shows its error). |
| `POST /api/send-email` (index) | **Breaks by design while email is disabled:** returns 503 `Service unavailable`, so the "email me my report" UI shows its failure state. Works only in live mode with a verified sender. Responses are `{ok:false,error}` (the old `Email service not configured` text is gone). |
| `POST /api/auth/change-password` (account, landing) | **Breaks:** 404 while `LEGACY_AUTH_API` is unset. The pages still contain the call. The live login path is Stack B / Supabase, so this changes a legacy KV password only; the UI will show an error until the product decision (remove the UI, or authorise the legacy route after an identity review). |
| `/api/business/*`, `/api/auth/login`, `/api/auth/register` | Not called by any shipped page; now 404. |
Other effects: the origin allowlist must list **every** host that serves the site (production domain, the Pages preview host, any `www`); a request without an `Origin` header is refused on browser routes. Email templates still link to hostnames chosen by the original project (`infinicus-validation.pages.dev` in `send-email`, `infini-cus.com` elsewhere): in a new account those links point at the original site until the templates are updated in a later change.

## Remaining attack surface
- **Unverified recipients:** user-addressed mail (`send-email`, waitlist welcome, nurture) can be triggered toward a third party's address. Bounded by per-IP, per-recipient (3/day, welcome 2/day) and global caps, strict escaping and fixed templates, but there is no proof of mailbox ownership. Blocker for live mode: choose double opt-in or accept the residual risk.
- **Cost abuse:** `simulate` and `parse-idea` remain anonymous; KV counters are not atomic (a burst can exceed a limit). Needs a provider spend cap, then Turnstile and/or a Cloudflare Rate Limiting rule.
- **Legacy families:** their code is intentionally unchanged (unauthenticated, wildcard CORS, client-supplied `user_email` / `business_id`). Safe only while the flags stay unset.
- **Static origin check is browser-only:** non-browser clients can send any `Origin`; the routes accept that risk because they are anonymous by design.
- **Prompt content:** `simulate` still places validated user text in the model prompt (the output goes only to the requester).
- **Signup storage:** the waitlist stores raw (not escaped) names; they are escaped at render time.

## Architecture
No Stack B import, table, tenancy or identity concept in any changed file (tests scan). No new identity or tenant authority. Legacy D1 `decision_memory` routes stay inside the default-deny family; nothing here promotes them to outcome authority (SOT-02 / V-13). The chain ADI -> ABA -> AuthorizedActionPackage -> BO -> ExecutionEvidence -> OM -> CL is untouched. Conflict C1 from the security design stands: legacy "ownership" is email equality only, which is why `/api/business/**` and `/api/auth/**` are denied rather than patched.

## Cross-PR notes
- PR #52 (`scripts/build-public.mjs`): `wrangler` now lists `/api/business/*` and `/api/auth/*` (middleware collapses the families), so PR #52's `--compare-routes` step will report a mismatch with its per-file route discovery once both are merged. Its discovery needs to treat `_middleware.js` as a prefix rule. The generated `_routes.json` (`/api/*`) is unaffected. Not changed here because PR #52 must stay untouched.
- The middleware files are written as `export { onRequest }` so PR #52's handler scan does not mistake them for routes.
- This PR contains the PR #53 commit; merge #53 first (or this PR shows both).

## Deployment blockers
1. Owner decisions: double opt-in vs accepting unverified recipients; Turnstile timing; fate of the `change-password` UI.
2. Configure the names above in the **new** project (never in the repo), including `ALLOWED_ORIGINS` for every serving host and the KV bindings.
3. A provider spend cap on the AI keys; a Cloudflare Rate Limiting rule for `simulate`/`parse-idea`.
4. Verified sending domain at the email provider before `EMAIL_MODE=live`.
5. Reconcile PR #52's route comparison (above).
6. Update email template links for the new hostname.
7. Everything in the earlier security design that is not code (Access policy on `*.pages.dev`, D1 verification, build settings).

## Verification
```
npm install --no-save --no-package-lock @anthropic-ai/sdk@0.39.0
node --test scripts/tests/functions-routes.test.mjs scripts/tests/functions-guard.test.mjs
npx wrangler@3.114.17 pages functions build functions --outfile /tmp/_worker.js --output-routes-path /tmp/routes.json
```
