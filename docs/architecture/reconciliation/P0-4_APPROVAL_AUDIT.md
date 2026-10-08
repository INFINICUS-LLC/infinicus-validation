# P0-4 Block 1 — Approval Audit Trail

Status: Blocks 1 and 2 merged (#45, #46); Block 3 merged (#47, see `P0-4_BLOCK3_AUTHORIZATION_AUDIT.md`); acceptance record: `P0-4_ACCEPTANCE.md`. Locked-spec reference: ABA §25 (audit record).
No locked spec, migration, or ABA→BO path is changed by this block.

## Purpose
Every approval decision outcome leaves an audit record: approve, approve with
modifications, reject (success paths) and denied / blocked refusals.

## Architecture
- `packages/workflow/src/approvalAudit.ts` — pure contract. `buildApprovalAuditDetail`
  produces the `approval-audit/1` detail document; `auditEventTypeFor` maps outcomes.
- `ApprovalDecisionRepository.decide` — inserts the audit event into
  `approved_business_action.approval_audit_events` **in the same transaction** as the
  decision status updates. A failing audit insert rolls the decision back.
- `DecisionWorkflowService.submitApprovalDecision` — wraps the decision; refusals
  (`ApproverAuthorityNotEstablishedError`, `ApprovalPolicyDeniedError`,
  `ApprovalBlockedError`) are audited as `approval.denied` / `approval.blocked` with
  reason codes. Other errors (validation, not found) are not audited.
- API route supplies `requestContext { permissionUsed: 'aba:write', correlationId }`.

Event types: `approval.approved`, `approval.approved_with_modifications`,
`approval.rejected`, `approval.denied`, `approval.blocked`.

## §25 field coverage
Recorded: decision ID, approver (user/assignment/role), approval type, prior state,
new state, timestamp (`occurred_at`), reason, permission used (when route supplies it),
Twin snapshot ID, plus review facts (risk class, time sensitivity, valid_until).
Not available in the current data model — recorded as `null` and named in
`detail.unavailable`: action ID, modified parameters, simulation run ID, model/version.

## Known limitations
- Refusal audit is best-effort: a failed write is logged and the original refusal is
  still thrown (success audit is atomic).
- `permissionUsed` is only set when the caller supplies `requestContext`.
- Expiry events are covered by Block 2 (below).
- No dedicated "recalculate decision" operation exists.

## Tests
- `packages/workflow/tests/approvalAudit.test.ts` — pure contract.
- `DecisionWorkflowService.integration.test.ts` — live Postgres: one event per outcome,
  atomicity, append-only, completeness, refusal auditing, audit failure never masks refusal.
- Mutation proofs (each caught): dropping audit param on approve (4 failed); disabling
  refusal audit (4 failed); letting audit failure mask refusal (1 failed); removing the
  in-transaction insert (7 failed).

## Future extension
Block 3 contract/e2e + route-permission inventory; P0-5
AuthorizedActionPackage will populate action ID / modified parameters.

## Block 2 — Expiry audit on detection (owner ruling)

Expiry is a derived state: persisted `valid_until <= database now()`. No scheduler, queue,
cron, polling worker or background mutation is added. Observing expiry leaves one
`approval.expired` event in `approved_business_action.approval_audit_events` (the table's
`event_type` is open text — no vocabulary change, **no migration**).

Detection points (authoritative paths only):
- `submitApprovalDecision`: after the review version is read with the database clock, any
  attempt (approve, approve_with_modifications, reject) on an expired version records the expiry.
  The outcome is unchanged: approving is still refused (`ApprovalBlockedError` EXPIRED, plus the
  Block 1 `approval.blocked` event), rejecting still works.
- `getReviewApprovalStatus(ctx, businessId, reviewPackageId)`: a passive service-level status read
  returning `{ expired, validUntil, packageStatus, evaluatedAt }` from persisted facts and the
  database clock. No HTTP route is added by this block (a route needs an owner decision on the
  permission to require).

Event detail (`approval-audit/1`): sourceLayer `ABA`, reasonCode `valid_until_elapsed`, businessId,
reviewPackageId, reviewVersionId (+number), sourceRecommendationVersionId, validUntil, detectedAt
(database time), reviewStatus, detectionPath (`approval_attempt` | `status_read`), actorUserId,
correlationId. Tenant/workspace/business are the row's scope columns.

Fabrication-proof: `ABAAuditRepository.recordExpiryDetected(ctx, businessId, reviewVersionId, context)`
takes only a version id and request context. valid_until, status and detected_at are read inside the
transaction from the persisted version and `now()`; if the version is not expired on the database
clock it writes nothing.

Idempotency: logically one event per review version. A transaction-scoped advisory lock keyed on
the version serialises concurrent detectors and an existing event short-circuits. Only the expiry
fact is deduplicated; each refused attempt still writes its own `approval.blocked` event. (A unique
partial index would be a stronger DB-level guarantee but needs a migration (next free number 0176);
not required by the ruling and not added.)

Failure policy (same as Block 1): expiry audit is best-effort. A failed write is logged; an expired
review is never made approvable and a status read still returns the correct expired state.

Not done / notes: expiry is recorded only when a request touches the review (no proactive
notification or housekeeping — a future scheduler needs a concrete requirement); a review whose
approval is denied earlier than the version read (missing authority) records nothing; a new review
version with a later `valid_until` is a different version and is judged on its own.

Block 2 tests (live PostgreSQL): first detection with persisted facts + DB time + context; repeated
and concurrent detection once; approve blocked with the audit store down; reject allowed (review not
rewritten); passive read; audit failure on read; non-expired and NULL `valid_until` emit nothing;
unknown time-sensitivity keeps P0-3 fail-closed; database clock authoritative (application clock
shifted); forged detected_at/valid_until ignored; scope isolation; append-only; repository refuses
non-expired versions. Mutation proofs (all caught): no idempotency check (2 failed), audit failure
propagates (2), application clock used (1), repository expiry guard weakened (1).
