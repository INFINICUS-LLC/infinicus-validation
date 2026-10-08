# P0-4 Block 3 — Authorization Boundary Audit and Remediation

Status: Block 3 (owner-authorised remediation F1/F2/F3/N3 + regression audit + ABA contract/e2e tests).
No migration (next free number remains 0176), no locked-spec change, no ABA→BO path, no override,
no owner backfill, nothing applied to live Supabase.

## Purpose
Prove that every HTTP route is explicitly authorised before domain work runs, and that the ABA approval contract
(authority, risk policy, persisted-fact gate, audit) holds end to end.

## Findings and rulings
| ID | Finding | Ruling / action |
|---|---|---|
| F1 | `GET /v1/businesses` had no permission | Now requires `bo:read` |
| F2 | `GET /v1/businesses/:businessId/workflow` aggregates BO, BI, DT, SIM, ADI, ABA, OM | Now requires ALL of `bo:read bi:read dt:read sim:read adi:read aba:read om:read` via the new `app.requireAllPermissions([...])` |
| F3 | `GET /v1/billing/subscription` had no permission | Now requires `platform:admin` (no `billing:read` exists; no migration) |
| N1 | Onboarding steps 2/3 take tenantId/workspaceId in the body | Accepted **bootstrap exception**, not an authorization bypass: identity is the authenticated session, `OnboardingService` rechecks `initiatedBy == session user`, supplied values are lookup keys not authority, RLS confines the lookup |
| N2 | `approverUserId` in request bodies | Acceptable: decisions re-verify it equals the authenticated user; the grant route treats it only as the grantee under `aba:admin` |
| N3 | Choice route passed no `requestContext` | Fixed: audit now records `permissionUsed=aba:write` and the correlation id. Approval semantics unchanged |
| N4 | `POST /decision-recommendations/outcome` takes client `approvedActionId` + `outcomeNotes` | **Legacy/interim compatibility surface only. Architectural debt for P0-5 / V-13 and later cutover.** Client text is not ExecutionEvidence; its observations stay unverified/manual and must not satisfy ExecutionEvidence, become VerifiedOutcomeEvidence, authorise OM verification, or enter CL as verified learning evidence. Not removed (SOT-02 retirement gates) |
| N5 | No route requires `aba:read` | Acceptable. Future review/status GET routes use `aba:read` (`getReviewApprovalStatus` stays service-level) |
| N6 | Swagger UI/spec under `/documentation` is public | **Deployment-hardening finding.** Not changed here unless the production spec requires private docs |
| N7 | `platform:admin` + `affectedTenantIds` on incident creation | Recorded for later platform-operator contract review; no evidence of an authorization defect |

## Mechanism
`requireAllPermissions(codes)` (`apps/api/src/plugins/permission.ts`) — AND semantics: every code is authorised in order via
`AuthorizationService.authorize` (fail-closed; each denial is access-event audited). An empty list throws at route declaration.

## Regression audit (no permanent allowlist for F1/F2/F3)
`apps/api/tests/routePermissions.test.ts` builds the real app and inspects each route's actual preHandler chain. Every route is either
classified BY DESIGN (public / session-only / onboarding bootstrap, each with a reason) or must run
`authenticate → resolveTenantContext → explicit permission` in that order. It also pins the F1–F3 and ABA permissions, forbids
role-name checks, restricts client-supplied identity/scope body keys to the reviewed cases, and asserts no business-operations route
accepts an ApprovedAction.

## Route permission matrix (88 handlers; HEAD/OPTIONS excluded)
| Method | Path | Domain | Required permission(s) | Identity / scope source | Result |
|---|---|---|---|---|---|
| GET | `/documentation/` | API docs | - | none | NOTE N6 |
| GET | `/documentation/static/index.html` | API docs | - | none | NOTE N6 |
| GET | `/documentation/static/swagger-initializer.js` | API docs | - | none | NOTE N6 |
| GET | `/documentation/json` | API docs | - | none | NOTE N6 |
| GET | `/documentation/yaml` | API docs | - | none | NOTE N6 |
| HEAD,GET | `/documentation/static/*` | API docs | - | none | NOTE N6 |
| GET | `/v1/health` | Platform | - | none | PASS (by design) |
| GET | `/v1/ready` | Platform | - | none | PASS (by design) |
| POST | `/v1/auth/register` | Authentication | - | none | PASS (by design) |
| POST | `/v1/auth/verify-email` | Authentication | - | none | PASS (by design) |
| POST | `/v1/auth/login` | Authentication | - | none | PASS (by design) |
| POST | `/v1/auth/logout` | Authentication | - | session user only | PASS (self-scoped) |
| GET | `/v1/auth/session` | Authentication | - | session user only | PASS (self-scoped) |
| POST | `/v1/onboarding` | Onboarding | - | session user; tenant/workspace body = lookup key, initiator rechecked | PASS (N1 bootstrap exception) |
| POST | `/v1/onboarding/:onboardingId/business` | Onboarding | - | session user; tenant/workspace body = lookup key, initiator rechecked | PASS (N1 bootstrap exception) |
| POST | `/v1/onboarding/:onboardingId/owner` | Onboarding | - | session user; tenant/workspace body = lookup key, initiator rechecked | PASS (N1 bootstrap exception) |
| GET | `/v1/onboarding/active` | Onboarding | - | session user; tenant/workspace body = lookup key, initiator rechecked | PASS (N1 bootstrap exception) |
| GET | `/v1/businesses` | Workflow / businesses | bo:read | verified headers+active membership; user=session; business=path (RLS) | PASS (was FAIL F1, remediated) |
| POST | `/v1/businesses` | Workflow / businesses | bo:write | verified headers+active membership; user=session; business=path (RLS) | PASS |
| GET | `/v1/businesses/:businessId/workflow` | Workflow aggregate | bo:read + bi:read + dt:read + sim:read + adi:read + aba:read + om:read | verified headers+active membership; user=session; business=path (RLS) | PASS (was FAIL F2, remediated) |
| POST | `/v1/businesses/:businessId/simulations` | Simulation | sim:write | verified headers+active membership; user=session; business=path (RLS) | PASS |
| GET | `/v1/businesses/:businessId/simulations/:runId` | Simulation | sim:read | verified headers+active membership; user=session; business=path (RLS) | PASS |
| POST | `/v1/businesses/:businessId/approver-assignments` | ABA | aba:admin | verified headers+active membership; user=session; business=path (RLS) | PASS |
| GET | `/v1/businesses/:businessId/approver-assignments/:assignmentCode` | ABA | aba:admin | verified headers+active membership; user=session; business=path (RLS) | PASS |
| POST | `/v1/businesses/:businessId/approver-assignments/:assignmentCode/revoke` | ABA | aba:admin | verified headers+active membership; user=session; business=path (RLS) | PASS |
| POST | `/v1/businesses/:businessId/decisions` | ABA | aba:write | verified headers+active membership; user=session; business=path (RLS) | PASS |
| POST | `/v1/businesses/:businessId/outcomes` | OM | om:write | verified headers+active membership; user=session; business=path (RLS) | PASS |
| GET | `/v1/metrics` | Observability | platform:admin | verified headers+active membership; user=session; business=path (RLS) | PASS |
| GET | `/v1/billing/subscription` | Billing | platform:admin | verified headers+active membership; user=session; business=path (RLS) | PASS (was FAIL F3, remediated) |
| POST | `/v1/billing/trial` | Billing | platform:admin | verified headers+active membership; user=session; business=path (RLS) | PASS |
| POST | `/v1/billing/payment-result` | Billing | platform:admin | verified headers+active membership; user=session; business=path (RLS) | PASS |
| POST | `/v1/incidents` | Incidents (platform) | platform:admin | verified headers+active membership; user=session; business=path (RLS) | PASS (N7 contract review pending) |
| GET | `/v1/incidents` | Incidents (platform) | platform:admin | verified headers+active membership; user=session; business=path (RLS) | PASS |
| GET | `/v1/incidents/:incidentId` | Incidents (platform) | platform:admin | verified headers+active membership; user=session; business=path (RLS) | PASS |
| GET | `/v1/incidents/:incidentId/updates` | Incidents (platform) | platform:admin | verified headers+active membership; user=session; business=path (RLS) | PASS |
| POST | `/v1/incidents/:incidentId/updates` | Incidents (platform) | platform:admin | verified headers+active membership; user=session; business=path (RLS) | PASS |
| POST | `/v1/incidents/:incidentId/resolve` | Incidents (platform) | platform:admin | verified headers+active membership; user=session; business=path (RLS) | PASS |
| POST | `/v1/businesses/:businessId/events` | Business Operations | bo:write | verified headers+active membership; user=session; business=path (RLS) | PASS |
| GET | `/v1/businesses/:businessId/events/summary` | Business Operations | bo:read | verified headers+active membership; user=session; business=path (RLS) | PASS |
| POST | `/v1/businesses/:businessId/operations/intake/:publicationPackageId` | Business Operations | bo:write | verified headers+active membership; user=session; business=path (RLS) | PASS |
| GET | `/v1/businesses/:businessId/operations/summary` | Business Operations | bo:read | verified headers+active membership; user=session; business=path (RLS) | PASS |
| GET | `/v1/businesses/:businessId/operations/inventory` | Business Operations | bo:read | verified headers+active membership; user=session; business=path (RLS) | PASS |
| GET | `/v1/businesses/:businessId/operations/procurement` | Business Operations | bo:read | verified headers+active membership; user=session; business=path (RLS) | PASS |
| GET | `/v1/businesses/:businessId/operations/suppliers` | Business Operations | bo:read | verified headers+active membership; user=session; business=path (RLS) | PASS |
| GET | `/v1/businesses/:businessId/operations/workforce` | Business Operations | bo:read | verified headers+active membership; user=session; business=path (RLS) | PASS |
| GET | `/v1/businesses/:businessId/operations/assets` | Business Operations | bo:read | verified headers+active membership; user=session; business=path (RLS) | PASS |
| POST | `/v1/businesses/:businessId/products` | Business Operations | bo:write | verified headers+active membership; user=session; business=path (RLS) | PASS |
| GET | `/v1/businesses/:businessId/products` | Business Operations | bo:read | verified headers+active membership; user=session; business=path (RLS) | PASS |
| PATCH | `/v1/businesses/:businessId/products/:productId` | Business Operations | bo:write | verified headers+active membership; user=session; business=path (RLS) | PASS |
| POST | `/v1/businesses/:businessId/register-sessions` | Business Operations | bo:write | verified headers+active membership; user=session; business=path (RLS) | PASS |
| GET | `/v1/businesses/:businessId/register-sessions/open` | Business Operations | bo:read | verified headers+active membership; user=session; business=path (RLS) | PASS |
| POST | `/v1/businesses/:businessId/register-sessions/:sessionId/close` | Business Operations | bo:write | verified headers+active membership; user=session; business=path (RLS) | PASS |
| GET | `/v1/businesses/:businessId/register-sessions` | Business Operations | bo:read | verified headers+active membership; user=session; business=path (RLS) | PASS |
| POST | `/v1/businesses/:businessId/orders` | Business Operations | bo:write | verified headers+active membership; user=session; business=path (RLS) | PASS |
| GET | `/v1/businesses/:businessId/orders` | Business Operations | bo:read | verified headers+active membership; user=session; business=path (RLS) | PASS |
| GET | `/v1/businesses/:businessId/orders/:orderId` | Business Operations | bo:read | verified headers+active membership; user=session; business=path (RLS) | PASS |
| POST | `/v1/businesses/:businessId/orders/:orderId/line-items` | Business Operations | bo:write | verified headers+active membership; user=session; business=path (RLS) | PASS |
| DELETE | `/v1/businesses/:businessId/orders/:orderId/line-items/:lineItemId` | Business Operations | bo:write | verified headers+active membership; user=session; business=path (RLS) | PASS |
| POST | `/v1/businesses/:businessId/orders/:orderId/complete` | Business Operations | bo:write | verified headers+active membership; user=session; business=path (RLS) | PASS |
| POST | `/v1/businesses/:businessId/orders/:orderId/void` | Business Operations | bo:write | verified headers+active membership; user=session; business=path (RLS) | PASS |
| GET | `/v1/businesses/:businessId/twin` | Digital Twin | dt:read | verified headers+active membership; user=session; business=path (RLS) | PASS |
| POST | `/v1/businesses/:businessId/twin/refresh` | Digital Twin | dt:write | verified headers+active membership; user=session; business=path (RLS) | PASS |
| POST | `/v1/businesses/:businessId/decision-recommendations` | ADI (+ABA/OM compat) | adi:write | verified headers+active membership; user=session; business=path (RLS) | PASS |
| POST | `/v1/businesses/:businessId/decision-recommendations/:recommendationId/choice` | ADI (+ABA/OM compat) | aba:write | verified headers+active membership; user=session; business=path (RLS) | PASS |
| POST | `/v1/businesses/:businessId/decision-recommendations/outcome` | ADI (+ABA/OM compat) | om:write | verified headers+active membership; user=session; business=path (RLS) | PASS (N4 architectural debt) |
| GET | `/v1/businesses/:businessId/decision-recommendations/history` | ADI (+ABA/OM compat) | adi:read | verified headers+active membership; user=session; business=path (RLS) | PASS |
| POST | `/v1/businesses/:businessId/data-sources` | Data Acquisition | da:write | verified headers+active membership; user=session; business=path (RLS) | PASS |
| GET | `/v1/businesses/:businessId/data-sources` | Data Acquisition | da:read | verified headers+active membership; user=session; business=path (RLS) | PASS |
| GET | `/v1/businesses/:businessId/data-sources/:sourceId` | Data Acquisition | da:read | verified headers+active membership; user=session; business=path (RLS) | PASS |
| PATCH | `/v1/businesses/:businessId/data-sources/:sourceId/status` | Data Acquisition | da:admin | verified headers+active membership; user=session; business=path (RLS) | PASS |
| DELETE | `/v1/businesses/:businessId/data-sources/:sourceId` | Data Acquisition | da:admin | verified headers+active membership; user=session; business=path (RLS) | PASS |
| POST | `/v1/businesses/:businessId/data-sources/:sourceId/connectors` | Data Acquisition | da:write | verified headers+active membership; user=session; business=path (RLS) | PASS |
| GET | `/v1/businesses/:businessId/data-sources/:sourceId/connectors` | Data Acquisition | da:read | verified headers+active membership; user=session; business=path (RLS) | PASS |
| GET | `/v1/businesses/:businessId/data-sources/:sourceId/connectors/:connectorId` | Data Acquisition | da:read | verified headers+active membership; user=session; business=path (RLS) | PASS |
| POST | `/v1/businesses/:businessId/data-sources/:sourceId/connectors/:connectorId/health-check` | Data Acquisition | da:write | verified headers+active membership; user=session; business=path (RLS) | PASS |
| PATCH | `/v1/businesses/:businessId/data-sources/:sourceId/connectors/:connectorId/status` | Data Acquisition | da:admin | verified headers+active membership; user=session; business=path (RLS) | PASS |
| POST | `/v1/businesses/:businessId/data-sources/:sourceId/connectors/:connectorId/webhook-token` | Data Acquisition | da:admin | verified headers+active membership; user=session; business=path (RLS) | PASS |
| POST | `/v1/businesses/:businessId/data-sources/:sourceId/manual-intake` | Data Acquisition | da:write | verified headers+active membership; user=session; business=path (RLS) | PASS |
| GET | `/v1/businesses/:businessId/collection-runs` | Data Acquisition | da:read | verified headers+active membership; user=session; business=path (RLS) | PASS |
| GET | `/v1/businesses/:businessId/collection-runs/:runId` | Data Acquisition | da:read | verified headers+active membership; user=session; business=path (RLS) | PASS |
| GET | `/v1/businesses/:businessId/collection-runs/:runId/validation-results` | Data Acquisition | da:read | verified headers+active membership; user=session; business=path (RLS) | PASS |
| GET | `/v1/businesses/:businessId/collection-runs/:runId/quality-score` | Data Acquisition | da:read | verified headers+active membership; user=session; business=path (RLS) | PASS |
| GET | `/v1/businesses/:businessId/collection-runs/:runId/provenance` | Data Acquisition | da:read | verified headers+active membership; user=session; business=path (RLS) | PASS |
| POST | `/v1/businesses/:businessId/collection-runs/:runId/publication-package` | Data Acquisition | da:write | verified headers+active membership; user=session; business=path (RLS) | PASS |
| POST | `/v1/businesses/:businessId/publication-packages/:packageId/publish` | Data Acquisition | da:write | verified headers+active membership; user=session; business=path (RLS) | PASS |
| GET | `/v1/businesses/:businessId/publication-packages` | Data Acquisition | da:read | verified headers+active membership; user=session; business=path (RLS) | PASS |
| GET | `/v1/businesses/:businessId/publication-packages/:packageId` | Data Acquisition | da:read | verified headers+active membership; user=session; business=path (RLS) | PASS |
| POST | `/v1/webhooks/data-acquisition/:token` | Data Acquisition | - | connector token (path) + rate limit | PASS (by design) |

## Compatibility impact
- F1/F2: every system role (owner, admin, member, viewer) holds all the read permissions, so system-role users keep access. A custom
  role lacking any of the seven read permissions loses the workflow view.
- F3: only `owner` holds `platform:admin`; `admin`, `member`, `viewer` can no longer read the subscription over HTTP. The web app does
  not call these API routes (it uses the service layer), so no web change.

## Contract / e2e tests
`apps/api/tests/abaApprovalContract.integration.test.ts` (HTTP, live PostgreSQL): authority missing / revoked / never self-issued;
aba:read / aba:write / aba:admin boundary; role-tier × risk-class policy matrix incl. unclassified fail-closed; expired / stale /
unverifiable Twin / unknown time-sensitivity blocked with RECALCULATE DECISION while reject stays allowed; forged
risk_class / is_time_sensitive / valid_until / twin_snapshot_id ignored; audit propagation (permissionUsed, correlationId) incl. the
choice route; **real database fault injection** proving an audit failure rolls back the decision and never converts a refusal into success;
F1/F2/F3 behaviour. Expiry concurrency (parallel attempts + reads + direct recordings) is in `DecisionWorkflowService.integration.test.ts`.

Not reachable over HTTP: `is_time_sensitive=true` without `valid_until` (ADI refuses to author it); its ABA-side block is proven at the
service level.

## Future extension
P0-5 AuthorizedActionPackage will replace the N4 interim surface; P0-4 Block 4 adds the handoff.
