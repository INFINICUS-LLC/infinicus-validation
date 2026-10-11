# P0-5 — ABA authoring / administration routes

Status: implemented on `remediation/p0-5-aba-admin`, DRAFT PR. No migration (0181 not allocated). No ABA→BO transport, no BO
execution, no inventory mutation, no `ACTION_AUTHORIZED`, no ExecutionEvidence, no P0-6 activation.

## 1. Purpose

Make a Level 2 `AuthorizedActionPackage` issuable through governed, audited, idempotent routes, without any caller being able to
supply authority. The issuer (3d) remains the only sealer; the authoring service only prepares inputs and then calls it with
identifiers.

## 2. Architecture

```
route (apps/api/src/routes/abaAuthoring.ts, strict zod bodies, auth → tenant → permission → subscription → idempotency)
  → AbaAuthoringService (packages/workflow)        governance + preparation + audit; derives, never accepts, authority
      → repositories (packages/database)           DB re-verifies: final parameters, membership, Level 2 only, latest-version-only
      → GovernanceAuditRepository → audit.audit_events
      → AuthorizedActionPackageIssuer.issue(ctx, {actionId, correlationId, permissionUsed})   the only sealer
```

Identity (tenant, workspace, user) comes only from the authenticated request context. Correlation ids that are not UUIDs are
normalised to a UUID for storage; the original is kept in the audit detail.

## 3. Route inventory and permission matrix

| Group | Method + path | Permission |
|---|---|---|
| A | `POST /v1/aba/action-types` (register canonical definition) | `aba:admin` |
| A | `POST /v1/aba/action-types/:code/:schemaVersion/activate` · `/retire` | `aba:admin` |
| A | `GET /v1/aba/action-types` · `GET /v1/aba/action-types/:code/:schemaVersion` | `aba:read` |
| B | `POST /v1/aba/automation-policies` · `…/:policyCode/versions` | `aba:admin` |
| B | `POST …/:policyCode/versions/:versionNumber/enable` · `/disable` | `aba:admin` |
| B | `GET /v1/aba/automation-policies/:policyCode` · `GET /v1/aba/automation-enablement` | `aba:read` |
| C | `POST /v1/businesses/:businessId/authorized-actions/:actionId/capture` | `aba:write` + the decision's own active approver |
| D | `POST …/:actionId/owner` | `aba:write` (DB verifies ACTIVE membership in this tenant/workspace) |
| E | `POST …/:actionId/boundaries` | `aba:write` + the decision's own active approver |
| F | `POST …/:actionId/package` (issuer, no request body) | `aba:write` |
| G | `GET …/:actionId/authoring-status` | `aba:read` |

No new permission code. `aba:write` cannot perform any `aba:admin` mutation.

## 4. Decisions recorded (owner review requested)

- **A. Canonical only.** The caller supplies `{code, schemaVersion}`; the stored definition is derived from the shared contract and
  must match it exactly. Unknown or non-canonical types are refused; there is no workspace redefinition.
- **B. Level 2 only.** Policies can be created/versioned/enabled only at Level 2. Level 3 is refused with `NOT_ENABLED`; Level 4 is
  future/`NOT_ENABLED`; a stored Level 3 policy is also refused by the enable path. Only the latest version can be enabled (409).
- **C. Capture** follows an approved decision only (otherwise 409), is separate from the P0-1..P0-4 approval transaction, and has no
  `finalParameters` in the request: the service derives them from the approved delta, validates them against the canonical
  parameter schema, and the database re-derives and verifies them. `modifiedAt`, evaluation time and basis/dimensions are
  server-stamped from the DB clock and the contract. Evaluation evidence references are caller-supplied (no governance evaluation
  engine exists yet — see open items).
- **D. Owner** is assigned/reassigned as an append-only version; `assignedByUserId` is the authenticated user.
- **E. Boundaries** are fail-closed: `NOT_APPLICABLE` is refused for execution window, preconditions, budget, rollback and monitoring
  unless the canonical applicability allows it, and for the simulation run unless the type is in `SIMULATION_NOT_APPLICABLE_ALLOWED`
  (empty). Reason codes must be UPPER_SNAKE.
- **F. Issuer route** has no body; `permissionUsed` is audit-only. Replay returns the existing package (`REPLAYED`).
- **Audit.** Every governance mutation writes one `audit.audit_events` row (`aba.<entity>.<verb>`) with actor, permission used,
  tenant/workspace/business (business is null for workspace-level governance), target, timestamp, correlation id and reason, in
  the same transaction as the change (an audit failure rolls the mutation back). Rows are written only when state really changed.
  Approval authority provenance stays in `approval_authority_scopes`; `approval_audit_events` is untouched.
- **Idempotency.** Explicit replay for every route (`Idempotency-Key` header replays the stored HTTP response; domain-level replay
  returns the stored record with `created:false`); a conflicting replay is 409. Due instants compare as instants
  (`…:00Z` ≡ `…:00.000Z`).

## 5. Files

- `apps/api/src/routes/abaAuthoring.ts`, `apps/api/src/schemas/abaAuthoring.ts`, `apps/api/src/app.ts`, `apps/api/src/errors.ts` (`PackageIssuanceRefusedError → 409`)
- `packages/workflow/src/AbaAuthoringService.ts`, `AuthorizedActionPackageIssuer.ts` (optional audit-only `permissionUsed`), `index.ts`
- `packages/database/src/repositories/approved_action/GovernanceAuditRepository.ts` (new), `ActionTypeRegistryRepository.listAll`, `ApprovalDecisionRepository.getLatestVersion`, `AuthorizedActionCaptureRepository` (instant comparison for owner replay)
- Tests: `apps/api/tests/abaAuthoring.integration.test.ts`, `routePermissions.test.ts` (matrix + forbidden body keys), `packages/workflow/tests/abaAuthoring.architecture.test.ts`, `issuer.architecture.test.ts` (allow-lists extended to exactly the authoring service)

## 6. Open items for the owner (not decided here)

1. `audit.audit_events` has no append-only trigger; making governance audit immutable needs a migration (0181) — **not allocated**.
2. Governance-evaluation `PASSED` results are asserted through caller-supplied evidence references; there is no evaluation engine.
3. Capture and boundaries are restricted to the decision's own still-active approver; confirm this is the intended authoring authority.
4. `aba:read` is used for all reads (narrowest existing permission).

## 7. Before P0-6

ABA-side authoritative status provider with the live authority check, the real BO execution adapter, the pre-execution fresh status
re-check, and the feature flag (off). Nothing in this block activates any of them.
