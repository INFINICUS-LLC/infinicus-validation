# P0-1 — Authoritative approval authority (V-01) — implementation note

**Status:** implemented and validated locally on live PostgreSQL. First block of the V-01 sequence; **ABA→BO execution is NOT wired and stays off until P0-1…P0-5 pass.**
**Does not change** any locked specification, any migration, or the ABA→BO isolation.

## What changed
| Before | After |
|---|---|
| `submitApprovalDecision` created, versioned and activated an approver assignment for a user named in the request, then consumed it in the same call. | `submitApprovalDecision` only **checks** for an existing `active` assignment for `ctx.userId` + business + `assignmentCode`. It creates nothing. |
| The approver was whatever `approverUserId` the caller sent. | The approver is the authenticated principal. `approverUserId` is optional; if present and different from `ctx.userId` the decision is refused. |
| No way to establish authority separately. | `DecisionWorkflowService.grantApproverAuthority` and `POST /v1/businesses/:businessId/approver-assignments`, gated by `aba:admin` (already seeded by migration 0137: "Administer approval policy and authority configuration"). A separate request from deciding. |
| Refusal: none. | HTTP 403 `ApproverAuthorityNotEstablishedError` (no assignment, revoked/draft assignment, or approver ≠ principal). |

Files: `DecisionWorkflowService.ts`, `ApproverAuthorityRepository.findActiveForUser`, `routes/businesses.ts`, `schemas/businesses.ts`, `errors.ts`, `BusinessDecisionRecommendationService.ts` (owner choice flow), web `actions.ts`.

## BREAKING CHANGE (intended, required by the V-01 ruling)
Any flow that decides without prior authority now fails with 403 until authority is granted: `POST …/decisions`, the web workflow approval action, and the business-owner choice flow (`startChoiceReview`), which uses assignment code `business-owner-approver` (`DEFAULT_APPROVER_ASSIGNMENT_CODE`).
**Operational step before this reaches production:** for each business whose owner uses these flows, an `aba:admin` user calls `POST /v1/businesses/:id/approver-assignments` with `{approverUserId, assignmentCode: "business-owner-approver"}` once. Automating this at business creation is a separate, approvable change (it must still originate from an authoritative identity/role, not from the approval request).

## Not done here (by design, later blocks)
- P0-2 action-risk policy; P0-3 `risk_class`/`valid_until`; P0-4 audit-record validation; P0-5 `AuthorizedActionPackage`; P0-6 ABA→BO wiring.
- Grant audit trail beyond existing access events: resolved by owner ruling D3 (P0-4) - `approval_authority_scopes` is the canonical record of authority grant/revoke; not duplicated into `approval_audit_events`.
- Web workflow action still takes `tenantId/workspaceId/userId` from the form. That is a separate trust issue; recorded for the identity block (V-05/V-04).

## Validation (local, pnpm 10.33.0, live PostgreSQL 16)
Build 28/28 (includes typecheck), lint 28/28, migration gate + grants, tests: workflow 15 passed, api 81 passed, database 2901 passed, web 14 passed. New tests: no authority → 403 and no assignment row created; different approver → 403; revoked → refused; grant without `aba:admin` → 403; grant then decide → 201.
