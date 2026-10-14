# AC-3 — Option B owner decision record

| Field | Value |
|---|---|
| Decision identifier | AC-3-J3-OPTION-B-2026-10-14 |
| Date | 2026-10-14 |
| Decision maker | INFINICUS owner (instruction given in the Claude Code session; recorded here by the engineering assistant) |
| **Status** | **CONDITIONALLY APPROVED** — design only. *Not* production-accepted, *not* live-verified. |
| Scope of this record | Documentation only. No code, Compose, CI, environment, production or database change. |
| Criterion J | **OPEN** |

This record is not an electronic signature and is not a formally signed document. It records an instruction the owner gave in writing in the session; the pull request that carries it is a draft and the owner's merge is the only act that makes it part of `main`.

## 1. What is decided
The owner selects **Option B — server-verified Supabase identity exchange, without HMAC** as the INFINICUS authentication architecture, subject to the conditions in §9 and §12.

The approval covers the architectural design only. It is **not**: production release approval; live authentication acceptance; permission to modify production infrastructure; authorization to rotate or delete credentials; permission to close Criterion J; or authorization for further remediation blocks.

## 2. Approved sequence (preserved)
1. The user authenticates with Supabase.
2. The browser obtains a Supabase access token.
3. The browser sends only `{accessToken}` to `POST /v1/auth/identity-exchange`.
4. The API validates the token against the configured Supabase identity provider.
5. The API requires a valid provider UUID and a confirmed email.
6. The API resolves or provisions the corresponding managed backend account.
7. The API issues a cryptographically secure backend session.
8. Protected operations require active workspace membership, permissions and appropriate business scope.

The browser is never an authoritative source of user identity, tenant ownership, membership or permissions.

## 3. Why mandatory HMAC derivation is rejected
`SHADOW_ACCOUNT_SECRET` is not introduced merely to derive managed-account identifiers. The authentication boundary is the server-side verification of the provider token (steps 4–5), not the secrecy of the identifier. A managed account cannot be used through password login or public registration, so knowing or computing its identifier grants nothing; only a verified provider token yields a session. An HMAC would add a long-lived secret to store and rotate, and would change every existing managed-account mapping, without strengthening that boundary. The identifier derivation is therefore not treated as a secret and must not be relied on as one.

## 4. Frozen managed-account identifier contract
```
shadow-<first 32 hex characters of SHA-256("infinicus-shadow-email-v2:" + providerUUID)>@infini-cus.local
```
Frozen, none may change without an explicit compatibility and migration plan approved by the owner: the derivation prefix; the hashing algorithm; the `infini-cus.local` managed domain; existing managed-account mappings.

Managed accounts (`@infini-cus.local`) must not authenticate through password login or public registration (unusable password hash; login and register refuse the domain).

## 5. Authentication and session requirements
- Backend session token: cryptographically random, 256-bit; only its SHA-256 is stored; server-side expiry (24 h) and revocation preserved.
- Browser cache of the session in `sessionStorage` is a convenience of at most 10 minutes. **It is not the backend session lifetime**; the server session lives up to 24 h unless revoked or expired.
- Sign-out, `SIGNED_OUT` and identity switching revoke the backend session (R1). A revocation that fails must be recorded as failed and never reported as a successful revocation.
- The token verifier requires a valid provider UUID and a confirmed email; the exchange body accepts `accessToken` only.

## 6. Security assumptions and trust boundaries
- Trusted: the configured Supabase project's `auth/v1/user` answer, reached over HTTPS from the API; the API's own database and session store.
- Not trusted: anything the browser supplies other than the provider access token (identifiers, tenant, business, membership, permissions, API base).
- Dependency: Supabase availability. If it is unreachable, new exchanges fail closed (503); existing sessions continue until expiry or revocation. The design accepts this dependency; it does **not** waive secure configuration, token validation, authorization or production verification.
- Assumed, not yet verified in production: that `SUPABASE_URL` / `SUPABASE_ANON_KEY` point to the authorized INFINICUS project (Gate A).

## 7. Implementation references (state verified against GitHub on 2026-10-14)
| Item | Reference | State |
|---|---|---|
| AC-3 Block 1 inventory | PR #129, `dc32f4d` | merged |
| Blocks 2+3 (J-1, J-6, J-2) | PR #130, `2827ab0` | merged |
| Block 4 — J-3 identity exchange, J-7 | PR #131, `2b2a0f1` | merged |
| Block 5 — J-4/J-5 assessment and legacy-flag guard | PR #132, `d25fad8` | merged |
| Block 6 — final verification report | PR #133, `fe454eb` | merged |
| Release Block R1 — Compose pass-through, session revocation on sign-out | PR #134, `130bf5a` on `main` | **merged to `main` (not deployed)**. R1 remains a separate release gate: merged code is not a deployed or verified release. |

Related documents: `infinicus-platform/docs/production-readiness/ac3-j3-identity-exchange.md`; `infinicus-platform/docs/production-readiness/ac3-r1-release-compatibility.md`; `docs/architecture/reconciliation/AC-3_COMPLETION_REPORT.md`; `docs/architecture/reconciliation/AC-3_BLOCK5_J4_J5_ASSESSMENT.md`.

Verification evidence cited by those PRs (pre-deployment, fake identity provider, local PostgreSQL 16 and GitHub CI): identity-exchange integration, verifier, browser-credential, logout, Compose and page-bridge-revocation suites. **No test has been run against a real Supabase project.**

## 8. Excluded work (not authorized by this decision)
Production deployment or release; any change to production Supabase variables or other production configuration; owner Step 2; live authentication tests; production database access or migrations; password rotation or neutralization; deletion of legacy authentication code; session-cookie migration; further Criterion J remediation blocks; declaring Criterion J closed.

## 9. Production acceptance gates
Option B may be considered production-accepted only after **all** gates pass, with evidence recorded and without revealing configuration values or credentials.

| Gate | Requirement | Status |
|---|---|---|
| **A — Configuration readiness** | `SUPABASE_URL` and `SUPABASE_ANON_KEY` correct and passed to the API container through the approved Compose configuration; endpoint belongs to the authorized INFINICUS Supabase project; no development endpoint or unauthorized identity provider accepted in production | NOT VERIFIED |
| **B — Legacy endpoint isolation** | `LEGACY_AUTH_API` and `LEGACY_BUSINESS_API` disabled in Cloudflare Production **and** Preview; `EMAIL_MODE` not `live`; legacy endpoints default-deny; no route bypasses the middleware | NOT VERIFIED (repository guard exists; production values unknown) |
| **C — Deployment inventory** | Which application serves `infini-cus.com`; whether Cloudflare Pages auto-deploys `main`; API version at `api.infini-cus.com`; public site and API compatibility; whether `apps/web` is deployed anywhere — each with evidence | NOT VERIFIED |
| **D — Real identity-provider verification** | With an explicitly authorized test account (never a customer account): invalid-token rejection; valid exchange; correct managed-account resolution; existing-account compatibility; session issuance; membership and permission enforcement; backend logout revocation; user switching; expired/revoked session rejection. Live requests need separate authorization | NOT RUN |
| **E — Release compatibility** | Old/new browser and API compatibility assessed (old password-based browser flow is refused for managed accounts by design); coordinated release procedure and rollback plan prepared. Authentication restrictions are not weakened to keep the legacy flow | Analysis exists (`ac3-r1-release-compatibility.md`); procedure not executed |

## 10. Open findings and accepted design trade-offs
Tracked, not silently resolved:
- **F1** JavaScript-readable backend session in `sessionStorage` (XSS exposure).
- **F2** Provider identifier persisted in `localStorage`.
- **F3** Cached backend session not refreshed automatically after a 401.
- **F4** Legacy password hashes derived from provider identifiers.
- **F5** Legacy browser identifier adoption across users.
- **F7** Repeated exchange creates multiple sessions; 24 h server-side expiry.
- **F6** Backend revocation on sign-out: implemented in R1 (merged to `main`), **pending deployed verification**.
- Supabase availability dependency (§6).

## 11. Conditions that would invalidate this approval
- Introduction of a browser-derived or browser-supplied credential, identifier, or authority.
- Any change to the frozen identifier contract (§4) without an approved migration plan.
- Weakening managed-account password/registration restrictions, or accepting an unauthorized identity provider or development endpoint in production.
- Enabling `LEGACY_AUTH_API`, `LEGACY_BUSINESS_API` or `EMAIL_MODE=live` in a way that bypasses Gate B.
- Reporting a failed revocation as successful, or treating the 10-minute browser cache as the session lifetime.
- A material change to the exchange flow (§2) not re-approved by the owner.

## 12. Conditions for final acceptance
All of Gates A–E pass with recorded evidence; the owner separately authorizes the production release and the live test; the open findings in §10 are prioritised by the owner; and the owner records final acceptance in writing. Until then Option B is **conditionally approved**, **real Supabase verification is pending**, **production deployment is not authorized**, and **Criterion J remains open**.
