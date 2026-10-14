# AC-3 Block 5 — J-4 and J-5 assessment

Date: 2026-10-14. Base: `main` at `2b2a0f1` (PR #131 merged). Scope: code and repository configuration only. **No production access, no flag change, no deploy.**

## Result in one paragraph
Neither J-4 nor J-5 needed a production-code change. Both were already hardened by the PR-C legacy-route work (shared gate, default-deny middleware) and are pinned by existing tests; the Block 1 inventory rated them from an unverified subagent report and under-stated that. What this block adds is (a) independent re-verification, (b) a repository guard so a commit cannot switch the legacy surfaces on, and (c) the corrected status below. **The one thing the repository cannot show is the production value of `LEGACY_AUTH_API` / `LEGACY_BUSINESS_API`; J-4 therefore stays OPEN until the owner confirms them.**

## J-4 — `functions/api/auth/**`, `functions/api/business/**`
| Question | Evidence | Status |
|---|---|---|
| Are the families denied by default? | `_middleware.js` in each family returns 404 via `legacyRouteGate` unless the flag is exactly `"enabled"`; before any route code runs, for every method including OPTIONS | VERIFIED (code + test) |
| Can a new route file escape the gate? | Structural test walks `functions/api/**`: every file is either a shared-gate route or sits under a family with the gating middleware; counts pinned (9 business, 5 auth) | VERIFIED (test) |
| Does any tracked config enable the flags? | None in `wrangler.toml`, workflows, scripts or env examples; new `legacy-flags-guard.test.mjs` fails the build if one ever does | VERIFIED (new test) |
| Is the legacy route code safe if enabled? | **No.** It stays unauthenticated (browser `user_email` / `business_id` / `decision_id`), wildcard CORS, no throttling. It is deliberately preserved and pinned as unhardened | KNOWN, unchanged |
| Production flag value | Not knowable from the repository | **UNKNOWN — owner action** |
| Functional side effect | `account.html:862` and `landing.html:1667` call `/api/auth/change-password`, which is 404 while default-deny holds. Not a security issue; a product decision (route it to Stack B) | NOTED |

Severity: none while default-deny holds (current code); CRITICAL only if production sets either flag to `enabled`.

## J-5 — `functions/api/{waitlist,feedback,simulate,parse-idea,send-email}`
| Control | Evidence |
|---|---|
| Shared gate on all five | structural test asserts `await gate(context,` in each |
| Exact-origin allowlist (no wildcard CORS), bounded body, strict field schema | `route.js` / `guard.js`; route tests |
| Per-IP and global limits, fail-closed when the counter store is missing | each route's `limits`; `route.js` |
| `send-email` disabled by default (503), fixed subjects, sender from server config, per-recipient quota 3/day, optional recipient-domain allowlist | `send-email.js`, `_shared/email.js` |
| **Open design gap (documented in the code):** in `EMAIL_MODE=live` a requester can have a report mailed to an address they typed without proving ownership (no double opt-in) | `send-email.js` header |

Status: no privileged mutation or tenant data is reachable; the residual risk is abuse/cost (best-effort limits) and, only if live email is ever enabled, third-party mail. Per the Block 1 ruling this is outside Criterion J unless it causes a privileged mutation; documented, not built.

## Files in this block
`scripts/tests/legacy-flags-guard.test.mjs` (new), `.github/workflows/functions-routes.yml` (path filters + command only), this document.

## Verification
- `node --test scripts/tests/functions-routes.test.mjs scripts/tests/functions-guard.test.mjs scripts/tests/browser-credentials.test.mjs` — 142 pass, 0 fail (before the new test).
- `node --test scripts/tests/legacy-flags-guard.test.mjs` — 3 pass. Mutation control: appending `LEGACY_AUTH_API = "enabled"` to `wrangler.toml` makes it fail (2 failed); reverted.

## Owner decisions (pending)
1. **Are `LEGACY_AUTH_API` and `LEGACY_BUSINESS_API` unset in production?** Check the Cloudflare Pages project variables (Production and Preview). Recommendation: confirm unset and keep default-deny. If either is `enabled`, disable it as an operational change; that is outside this block.
2. Is J-5 out of scope for Criterion J (documented only)? Recommendation: yes.
3. Before ever setting `EMAIL_MODE=live`: add recipient-ownership proof (double opt-in). Recommendation: keep disabled.
4. `change-password` in `account.html` / `landing.html`: route to Stack B or remove the control (product follow-up).
5. Retire (delete) the legacy `auth/**` and `business/**` route code once decision 1 is confirmed. Recommendation: yes; it removes the risk permanently.
