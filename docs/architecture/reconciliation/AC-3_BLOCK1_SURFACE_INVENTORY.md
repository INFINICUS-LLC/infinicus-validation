# AC-3 Block 1 — Surface inventory and threat map (Criterion J)

Status: inventory only. No code, migration, contract or deployment change in this block. Evidence is from reading the repository at `origin/main` 6e0930c plus two throwaway probes against a private PostgreSQL 16 (deleted after use; results recorded here). Nothing was run against production. Confidence is stated per finding.

## 1. Method
- Stack B API (`infinicus-platform/apps/api`): the full route table (about 100 routes) was extracted from the route files and cross-checked against the existing `apps/api/tests/routePermissions.test.ts`, which already fails the build if a non-classified route lacks authenticate -> resolveTenantContext -> explicit permission, or if a body/param carries a reviewed identity key outside the reviewed list.
- Cross-tenant probe: a valid owner of tenant A called about 45 `/v1/businesses/:businessId/...` routes with tenant B's business id; a second probe chained the confirmed gap (section 5, J-1).
- Browser surfaces read: `apps/web` (Next.js), `apps/admin`, root static pages (`index.html`, `account.html`, `landing.html`, `dal.html`, `bol.html`), and `functions/api/**` (Cloudflare Pages Functions, Stack A). The Stack A reading was done by a read-only subagent; I re-read `functions/api/business/_middleware.js` and `functions/api/business/manage.js` myself and found them consistent with its report. The rest of its report is unverified.

## 2. Authoritative model on Stack B (what "server-authoritative" means today)
- Principal: `authenticate` validates the bearer session token server-side (`AuthenticationService.validateSession`).
- Scope: `resolveTenantContext` takes `X-Tenant-Id` / `X-Workspace-Id` as a claim and accepts it only if the authenticated user has an ACTIVE membership in that exact tenant and workspace (read from the database on every request). The headers choose among the user's own memberships; they never grant one.
- Role/permission: `requirePermission` / `requireAllPermissions` -> `AuthorizationService.authorize`, which re-reads the membership, its role ids and the role permissions from the database on every call (revocation takes effect on the next request; nothing is cached). Permission codes only, never role names (pinned by `routePermissions.test.ts`).
- Row isolation: forced row-level security on tenant tables with the application role neither superuser nor BYPASSRLS (final audit).
- Target resource: `:businessId` is a target identifier only. Most handlers call `businesses.getById(ctx, businessId)` (404 outside the caller's tenant/workspace). Section 5 lists the paths that do not.
- Audit actor: services take `ctx.userId`; the decision approver must equal the authenticated user (`DecisionWorkflowService.ts:432`).

## 3. Classification
Classes: A authoritative mutation/privileged, B governed approval/execution, C administrative, D read-only, E dead/unreachable legacy.

### 3.1 Stack B API (`apps/api`)
| Surface (routes) | Class | Principal | Role source | Tenant/business scope source | Target id source | Permission | Browser-trusted identity/scope input |
|---|---|---|---|---|---|---|---|
| `POST /v1/auth/register|login|verify-email` | public (pre-auth) | n/a | n/a | n/a | body email/token | none by design | none |
| `POST /v1/auth/logout`, `GET /v1/auth/session` | session | bearer session | n/a | own session | none | authenticate | none |
| `POST /v1/onboarding`, `.../:id/business`, `.../:id/owner`, `GET /v1/onboarding/active` | A (bootstrap) | bearer session | owner role granted to the initiator | body `tenantId`/`workspaceId` are lookup keys; `OnboardingService` rechecks `initiatedBy == session user` | `:onboardingId` | authenticate only, by design (no membership yet) | `tenantId`, `workspaceId` (reviewed; not authority) |
| `/v1/billing/*` (3) | C | bearer | `platform:admin` | tenant ctx from membership | none | `platform:admin` | none |
| `/v1/incidents*` (6), `GET /v1/metrics` | C | bearer | `platform:admin` | tenant ctx | `:incidentId` | `platform:admin` | `affectedTenantIds` in `POST /v1/incidents` (reviewed; platform-operator contract review pending) |
| `/v1/aba/action-types*`, `/v1/aba/automation-policies*` | C | bearer | `aba:admin` writes, `aba:read` reads | tenant ctx | codes in path | per route | none (body keys pinned by test) |
| `/v1/businesses/:businessId/authorized-actions/:actionId/{capture,owner,boundaries,package}` | B | bearer | `aba:write` | `requireBusiness` -> `businesses.getById`, then action must belong to the business | `:businessId`, `:actionId` | `aba:write` | `ownerUserId`/`membershipId` in `/owner` are the GRANTEE; service requires an ACTIVE membership in the workspace |
| `.../authoring-status` | D | bearer | `aba:read` | same | same | `aba:read` | none |
| `POST /v1/businesses/:businessId/approver-assignments`, `GET|revoke .../:assignmentCode` | B/C | bearer | `aba:admin` | **not scope-checked** (J-1) | `:businessId`, body `approverUserId` (grantee) | `aba:admin` | `approverUserId` = grantee, reviewed |
| `POST /v1/businesses/:businessId/decisions` | B | bearer | `aba:write` + ACTIVE approver assignment for the caller | **not scope-checked** (J-1) | `:businessId`, `intakePackageId` | `aba:write` | `approverUserId` optional, must equal the caller else refused |
| `POST /v1/businesses/:businessId/outcomes` | A | bearer | `om:write` | **not scope-checked** (J-1) | `:businessId`, `monitoredActionId` | `om:write` | none |
| `POST .../decision-recommendations/:id/choice`, `.../outcome` | B | bearer | `aba:write` / `om:write` | no `getById`; published recommendation lookup fails first in the probe (404) | ids in path/body | per route | none |
| `PUT .../declared-currency`, `PUT .../execution-activations`, `POST .../execution-recoveries`, `PUT .../initial-reorder-policy`, `POST .../inventory-policy-evaluations`, `.../bi-evidence`, `.../twin-state`, `.../reorder-policy-recommendation`, `POST .../operations/intake/:packageId` | A/B/C | bearer | named permission per route (`platform:admin`, `bo:admin`, `bo:write`, `bi:write`, `dt:write`, `adi:write`, and others) | `businesses.getById` (probe: 404 for a foreign business) | `:businessId` and ids | per route | none |
| `POST|PATCH|DELETE` under `/data-sources`, `/connectors`, `/manual-intake`, `/publication-package*` | A | bearer | `da:write` / `da:admin` | `businesses.getById` | path ids | per route | none |
| `/v1/businesses` (list/create), `/orders*`, `/products*`, `/register-sessions*`, `/events*`, `/twin*`, `/simulations*`, `/workflow` | A (writes) / D (reads) | bearer | `bo:*`, `sim:*`, `dt:*` | `businesses.getById` or the service's own scoped query (probe: 404 or validation before scope for the rest; `simulations` and `workflow` 404) | path ids | per route | none |
| `POST /v1/webhooks/data-acquisition/:token` | public by design | connector token (unguessable, in path) | n/a | token resolves tenant/business server-side | token | rate limit | none |
| `GET /v1/health`, `/v1/ready` | public | n/a | n/a | n/a | n/a | none | none |

Probe cells that returned 400 (body validation before scope) are undetermined by the probe only: `events`, `products`, `register-sessions`, `operations/summary`, `execution-activations`, `execution-recoveries`, `inventory-policy-evaluations`, `bi-evidence`. Each of those handlers calls `businesses.getById` in its source (static read), so they are not listed as gaps; Block 2 will pin them with negative tests.

### 3.2 Browser-reachable surfaces outside the Stack B API
| Surface | Class | Reachable? | Identity/scope source | Finding |
|---|---|---|---|---|
| `apps/web` Next.js pages and server actions (`/businesses`, `/businesses/[id]/workflow`, `/history`; actions `submitApprovalDecisionAction`, `recordOutcomeAction`) | B (approval decision), A (outcome), D (reads) | Built by CI. Not in the Hetzner compose topology (postgres, api, tools). Deployment state otherwise unknown | `tenantId`, `workspaceId`, `userId` from URL query / hidden form fields (`lib/context.ts`, `actions.ts`) | J-2 |
| `apps/admin` | n/a | `src/index.ts` is 2 lines, no surface | n/a | none |
| Root static pages (`index.html` and others) calling the Stack B API as a signed-in shadow account | A (orders, events, simulations through bearer session) | Yes, production API `api.infini-cus.com` | Stack B session token (server-authoritative once issued); credential derivation in the browser | J-3 (V-04, V-05) |
| `functions/api/business/**` (manage, events, summary, twin, decisions/*) | A | Default-deny 404 unless `LEGACY_BUSINESS_API === 'enabled'`; production flag unknown | none (browser `user_email`, `business_id`, `decision_id`) | J-4 |
| `functions/api/auth/**` (register, login, change-password, request, verify) | A | Default-deny 404 unless `LEGACY_AUTH_API === 'enabled'`; `account.html` and `landing.html` call `change-password`; production flag unknown | email + password in body, KV store | J-4 |
| `functions/api/{waitlist,feedback,simulate,parse-idea,send-email}` | A (anonymous writes / paid calls) | Yes (origin allowlist, KV counters) | anonymous by design | J-5 |
| `functions/api/{nurture,nurture-batch}` | C | Server bearer secret, no CORS | shared secret, not a user | none for J |
| `functions/api/business/decisions.js` | E | dead duplicate (every action answers 400) | n/a | none |

## 4. Reconciliation of V-04 and V-05
- **V-04 (provider id fragment in the tenant slug):** still present in `index.html` (about line 3627, `tenantSlug: 'demo-' + supaId.slice(0, 8) + ...`). The slug is an INFINICUS tenant attribute created through the Stack B onboarding route. Confidence 90%.
- **V-05 (derived password and provider id in `localStorage`):** still present (`inf_backend_account_v2`, about lines 3492-3600): the Stack B shadow-account email and password are SHA-256 derivations of fixed labels plus `supaId`, stored in `localStorage`, and the browser logs in with them. Anyone who learns a user's Supabase id can compute the credentials. Confidence 90%.
- Stack B itself is server-authoritative once the session exists; the weakness is the credential, not the API.
- The earlier `OWNER_AUTHORITY_BOOTSTRAP.md` note that the web workflow form takes `tenantId`/`workspaceId`/`userId` from fields is the same defect as J-2 (this inventory confirms it is not fixed).

## 5. Remaining Criterion J gap list (exact)
| ID | Severity | Confidence | Surface | Defect | Evidence |
|---|---|---|---|---|---|
| J-1 | MEDIUM | 95% (probe-confirmed) | Stack B: `POST /v1/businesses/:businessId/approver-assignments`, `POST .../decisions`, `POST .../outcomes` (and the choice/outcome recommendation routes by the same pattern) | The business in the path is never checked against the caller's tenant/workspace; `approver_assignments.business_id` has a plain foreign key, not a (tenant, workspace, business) composite. A tenant-A principal with `aba:admin` + `aba:write` self-granted approver authority on tenant B's business and recorded an approved decision (201, rows in tenant A referencing B's business). Nothing visible to tenant B changed (row-level security), so no cross-tenant disclosure or authority over B was shown; scope-rejection is violated, and a foreign business id is distinguishable from an unknown one (201 vs 500 foreign-key error). `recordOutcome` with valid in-tenant ids was not run (inferred, 75%). | probes 1 and 2 (this block) |
| J-2 | HIGH if deployed; 80% confidence it is not deployed | `apps/web` server actions and pages | Identity (`userId`) and scope (`tenantId`, `workspaceId`) come from the URL/form with no authentication or membership check; the actions call `DecisionWorkflowService` directly. Supplying the userId of a holder of an active approver assignment records an approval; supplying a tenantId reads that tenant's workflow view. | `apps/web/lib/context.ts`, `.../workflow/actions.ts`, `page.tsx` |
| J-3 | MEDIUM-HIGH | 90% | `index.html` shadow-account bridge | V-05 and V-04 above. | `index.html` about 3492-3627 |
| J-4 | CRITICAL if the flags are enabled; none while default-deny holds | 85% on code, unknown on production flags | `functions/api/business/**`, `functions/api/auth/**` | Browser-supplied `user_email` / `business_id` / `decision_id` authorize reads and writes with no authentication; wildcard CORS; unthrottled login/change-password. Default-deny middleware returns 404 unless an exact flag is set. | `functions/api/business/_middleware.js`, `manage.js`; subagent report for the rest |
| J-5 | LOW-MEDIUM | 75% | `functions/api/{waitlist,feedback,send-email,simulate,parse-idea}` | Anonymous writes and paid calls, protected by an origin check and best-effort counters; `send-email` lets an anonymous caller pick the recipient once `EMAIL_MODE=live` (documented blocker in the code). | subagent report (unverified) |
| J-6 | LOW | 70% | Stack B approver grant | The grantee is not checked for workspace membership at grant time (an unknown user id fails with a foreign-key 500; an existing non-member user was not probed). Inert for authority because a decision needs the caller to be an active member, but it is a hygiene/robustness gap. | probe 2 (500 on unknown user) |
| J-7 | LOW | 80% | `index.html` | The API base URL can be overridden from `localStorage.inf_api_base_url`; if page script is compromised, credentials go to an attacker host. Subsumed by moving credentials out of script-readable storage. | `index.html` about 3480 |

Robustness (not a J blocker, record only): invalid foreign keys on `/decisions` and `/outcomes` surface as HTTP 500 instead of 404/409.

Reviewed and NOT a gap: onboarding body `tenantId`/`workspaceId` (lookup keys; `initiatedBy` recheck; owner role comes from the server-side bootstrap, no `created_by` inference, no backfill); `approverUserId` on decisions (must equal the caller); the ABA authoring routes (business and action scope checked server-side); permission evaluation (database each call, so revocation is immediate).

## 6. Proposed remediation order (Blocks 2+; each owner-gated)
1. **J-1** (Stack B): one shared business-scope guard used by the workflow service entry points, plus a composite (tenant, workspace, business) foreign key as a repository migration (not applied anywhere without the owner), unknown-business and foreign-business mapped to the same 404, negative tests for every proof in the AC-3 list. No change to AC-2 evidence-chain semantics.
2. **J-2** (`apps/web`): owner decision needed (see 7). Options: make the actions call the Stack B API with a server-validated session, or remove/disable the identity-taking pages. Either way the browser must stop supplying identity.
3. **J-3 / J-7** (`index.html`): replace the derived credential with a server-side token exchange; remove credentials from `localStorage`; remove the slug fragment. Requires the web/Supabase boundary to be designed; larger.
4. **J-4**: depends on the production flag state; if unset, document and keep the guard test; if set, disabling is an operational change outside this block.
5. **J-5**: owner decision on whether anonymous marketing endpoints are in J's scope (ruling 5 suggests no unless they cause a privileged mutation).

## 7. Questions for the owner
1. Are `LEGACY_AUTH_API` and `LEGACY_BUSINESS_API` unset in production? (Decides J-4: dead legacy vs critical.) Recommendation: confirm unset and keep default-deny.
2. Is `apps/web` deployed anywhere, or demo only? (Decides J-2 severity.) Recommendation: treat as a surface to close regardless, by removing the identity-taking inputs.
3. Is J-5 (anonymous marketing endpoints) in scope for J? Recommendation: out of scope under ruling 5, documented only.

## 8. Not done
No fix, migration, deployment, production access or merge. No test was added in this block.
