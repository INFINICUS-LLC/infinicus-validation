# P0-4 Block 1 — Approval Audit Trail

Status: implemented, DRAFT PR. Locked-spec reference: ABA §25 (audit record).
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
- Expiry events (no approver action) are not yet recorded — P0-4 Block 2.
- No dedicated "recalculate decision" operation exists.

## Tests
- `packages/workflow/tests/approvalAudit.test.ts` — pure contract.
- `DecisionWorkflowService.integration.test.ts` — live Postgres: one event per outcome,
  atomicity, append-only, completeness, refusal auditing, audit failure never masks refusal.
- Mutation proofs (each caught): dropping audit param on approve (4 failed); disabling
  refusal audit (4 failed); letting audit failure mask refusal (1 failed); removing the
  in-transaction insert (7 failed).

## Future extension
Block 2 expiry audit; Block 3 contract/e2e + route-permission inventory; P0-5
AuthorizedActionPackage will populate action ID / modified parameters.
