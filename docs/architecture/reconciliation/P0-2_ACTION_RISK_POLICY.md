# P0-2 — Action-risk approval policy

Locked basis: ABA §8 (role- and policy-controlled approval; cashier cannot approve strategic/financial actions, manager within limits, owner strategic) and §27 (higher-risk actions need stronger human review). Locked specs unchanged. No migration.

## What it does
`packages/workflow/src/approvalRiskPolicy.ts` (pure) maps an action's **risk class** to the minimum approver **authority tier**:

| risk class | minimum tier to approve |
|---|---|
| low | cashier (1) |
| medium | manager (2) |
| high | business owner (3) |
| critical | business owner (3) |

Tiers come from the assignment's current `role_code`: `cashier`=1, `manager`=2, `approver`=2 (legacy generic manual-grant role), `business-owner`=3. Unknown role = 0.

- `reject` is always allowed for any active approver. `approve` and `approve_with_modifications` are both gated.
- `DecisionWorkflowService.submitApprovalDecision` evaluates the policy after authority and the owner-proof re-check and before any decision row is written; a denial throws `ApprovalPolicyDeniedError` (HTTP 403) and records nothing.
- `grantApproverAuthority` / `POST …/approver-assignments` accept an optional `roleCode` (`cashier | manager | approver | business-owner`; default `approver`). Granting `business-owner` manually is the explicit `aba:admin` decision for businesses the owner dry-run classed UNPROVEN/AMBIGUOUS.

## Fail-closed choices
- **Risk is not accepted from API callers.** `riskClass` on `SubmitApprovalInput` is for trusted server code only; the decision route does not map it (a body `riskClass` is stripped, tested). Until P0-3 stores `risk_class` on the data model, every API-initiated approval is **unclassified and treated as `high`**, i.e. owner tier only.
- Unknown/invalid risk class, unknown role, prototype-key role names, or a malformed policy never allow approval.

## Behaviour change to note
Approvals through the API by a manager/`approver`-role holder are now denied (403) until P0-3 supplies a trusted risk class; owner-tier approvers (including the owner bootstrap flow, `business-owner`) are unaffected. Rejection is unaffected.

## Not in P0-2
Persisted `risk_class`/`valid_until` and stale-decision protection (P0-3, migrations); cost/reversibility/maturity thresholds from §8/§27; per-business policy tables (existing `approval_policies` tables are not yet consulted; the policy is injectable via the service constructor); audit events (P0-4); AuthorizedActionPackage (P0-5).

## Tests
`packages/workflow/tests/approvalRiskPolicy.test.ts` (pure, 10) and the "action-risk approval policy (P0-2)" block in `DecisionWorkflowService.integration.test.ts` (live PostgreSQL, per risk class/role, unclassified, reject, no row on denial, unknown role at grant) plus an API test. Mutation-proven: removing enforcement, making unclassified=low, or removing the reject allowance each fails tests.
