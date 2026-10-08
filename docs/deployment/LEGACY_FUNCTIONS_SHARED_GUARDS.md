# Legacy Pages Functions: shared security guards (PR-B)

Status: foundation only. **No route imports these modules in PR-B; live API behaviour is unchanged.** PR-C integrates them route by route.

## Purpose
The legacy Cloudflare Pages Functions (`functions/api/**`) fail open in places (an unset secret skips its check), allow any origin (`Access-Control-Allow-Origin: *`), trust unbounded request bodies, interpolate untrusted text into email HTML, and rely on per-isolate in-memory rate limits. PR-B adds two reviewed, dependency-free modules so PR-C can fix this once, consistently.

| File | Role |
|---|---|
| `functions/_shared/guard.js` | Configuration validation, constant-time bearer verification, exact-origin CORS, bounded body and field validation, generic error responses, safe security logging, rate-limit interface |
| `functions/_shared/escape.js` | HTML/attribute escaping, URL scheme allowlist, plain-text normalisation, number clamping, header-injection prevention, strict email-address syntax |
| `scripts/tests/functions-guard.test.mjs` | 50 unit and architecture tests |
| `.github/workflows/functions-guard.yml` | Path-filtered CI: tests plus a wrangler compile of the modules for the Workers runtime |

Neither file exports an `onRequest*` handler, so Pages never routes them (verified: the real `functions/` tree still compiles to the same 21 routes).

## Behaviour contract
| Concern | Behaviour |
|---|---|
| Missing or invalid security configuration | Never a bypass. `readSecret` / `requireGuardConfig` throw `GuardConfigError('unconfigured')`; `verifyBearer` returns `{ok:false, code:'unconfigured'}` (route answers 503). Secrets must be at least 32 chars, free of whitespace and control characters, not placeholder-like, with at least 10 distinct characters. Errors name the variable and a fixed reason code, never a value. |
| Bearer secrets | Single well-formed `Authorization: Bearer <token>` header only. Comparison is constant time: both sides are HMAC-SHA-256'd under a fresh random key and the fixed-length digests are compared without early exit. A static test forbids `===` between a token and a secret. |
| CORS | Exact-match allowlist from `parseAllowedOrigins` (https only; no wildcard, path, port variants, userinfo, upper case or IPv6 literals; localhost only if the caller opts in). Responses echo the exact origin with `Vary: Origin`; never `*` and never `Allow-Credentials`. Preflight validates origin, requested method and requested headers; failures are a generic 403 with no CORS headers. **Origin is a browser cross-site control, not authentication**: a non-browser client can send any Origin, and a test shows an allowed origin still fails bearer verification. |
| Request bodies | `readJsonBody` requires `application/json` (UTF-8), enforces the byte cap while streaming (Content-Length is checked but not trusted, and the stream is cancelled at the cap), rejects empty/malformed/non-UTF-8/BOM bodies, non-object roots, deep or huge structures and `__proto__` / `constructor` / `prototype` keys. |
| Field validation | `validateFields` returns a new object containing only declared, validated, normalised fields. Unknown fields are rejected, strings may not contain control characters or lone surrogates, errors are `{field, code}` with fixed codes and never echo values or unknown field names. |
| Escaping | `escapeHtml` encodes `& < > " ' \`` and strips control characters; only primitives are stringified (objects become empty text). Header values must be printable ASCII with no CR/LF/NUL; invalid names and values throw a generic message that never contains the input. |
| External errors | `errorResponse(code)` returns a fixed generic body per code (`{"ok":false,"error":"..."}`), `Cache-Control: no-store`, `nosniff`. Unknown codes (including `__proto__`) become a generic 500. |
| Logging | `logSecurityEvent` logs only `{event, route, code, status}`; each is a short lowercase token or the literal `invalid`. No request data, tokens, headers or personal data can reach the log. |
| Rate limiting | `createRateLimiter` requires an explicit `failure` (`closed`/`open`) and `purpose` (`abuse-smoothing`/`security-boundary`) and throws at creation if misconfigured. **KV and in-memory backends are `atomic:false` and are refused as a `security-boundary`**; that purpose requires an atomic backend and fail-closed. Keys are hashed (SHA-256) before they reach any backend; an unusable key or a backend error follows the declared failure mode and is flagged `degraded`; `check` never throws. |

## Architecture review
- **Stack B and SOT-02 / V-13:** these modules import nothing but each other, reference no D1/KV binding, no table and no Stack B concept; tests scan for `INFINICUS_DB`, `INFINICUS_USERS`, `infinicus-platform`, tenancy, session and password-hash terms, and assert that nothing under `infinicus-platform/` imports them. They create no identity, session, tenant or authorization authority and answer no "who owns this" question; ownership checks stay a PR-C concern and, for legacy routes, remain email equality only (conflict C1 in the security design). The locked chain ADI → ABA → AuthorizedActionPackage → BO → ExecutionEvidence → OM → CL is untouched.
- **Storage access:** the only possible write is through a rate-limit backend the caller passes in. The modules read configuration only through caller-supplied names.
- **Runtime compatibility:** Web APIs only (Web Crypto, Request/Response/Headers, TextEncoder/Decoder, URL). No Node built-ins, `Buffer`, `process`, `eval`, `fetch`, or `Math.random`. Verified three ways: unit tests under Node 22, a wrangler 3.114.17 compile, and execution of all primitives inside workerd (`wrangler pages dev`, 14 of 14 checks passed under `Cloudflare-Workers`).
- **Honest limits:** KV counters are eventually consistent and not atomic (a test demonstrates a burst of 10 passing a limit of 3), so rate limiting here is abuse and cost smoothing only. Strict limits need Cloudflare Rate Limiting rules or an atomic backend (for example a Durable Object) behind the same `hit()` interface. `getClientIp` trusts `CF-Connecting-IP` only.
- **No duplicate logic:** email syntax lives in `escape.js` and is reused by `validateFields`.

## Remaining PR-C integration work
All of this is deliberately **not** in PR-B:
1. Route gate order per route: `requireGuardConfig` → method → `handlePreflight`/`requireAllowedOrigin` → rate limit → `verifyBearer` (server routes) → `readJsonBody` → `validateFields` → business logic; every failure through `errorResponse` plus `logSecurityEvent`.
2. `nurture-batch`: bearer-only via `verifyBearer('NURTURE_BATCH_SECRET')`; remove the `if (secret)` fail-open; no CORS.
3. `simulate`: exact-origin check, body/field validation, rate limit, global daily budget; remove the optional-key fail-open without requiring a browser-held key. **Do not set `INFINICUS_API_KEY`**: the browser sends none.
4. `send-email`: `EMAIL_MODE` default disabled, verified `EMAIL_FROM`, `escapeHtml` for every interpolated field, `normalizeEmailAddress`, fixed subject and reply-to, per-recipient and per-IP limits.
5. `/api/business/*`: default-deny flag, then (only if a consumer is confirmed) a session design with owner scoping. Needs an owner decision and a separate identity review.
6. Replace `Access-Control-Allow-Origin: *` on every route; replace the in-memory limiters.
7. Route-level tests, including a regression test that every gated route returns 503 when its secret is unset.
8. New configuration names (values set by the owner, never in the repo): `ALLOWED_ORIGINS`, `EMAIL_MODE`, `EMAIL_FROM`, `LEGACY_BUSINESS_API`, later `TURNSTILE_SECRET_KEY`.

## Verification
```
node --test scripts/tests/functions-guard.test.mjs
```
