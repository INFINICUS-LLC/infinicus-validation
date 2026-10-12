# P0-6h - Interim operator control for stranded claims (Alternative A)

Status: implemented on a draft PR; **no migration, nothing deployed or activated, no live database change.** Production activation remains OFF.

## 1. Purpose

P0-6g recovers stranded claims automatically through a durable per-claim signal. One path remains: if the governed gate is closed (business
DISABLED or the global kill switch) when that signal falls due, the signal is dead-lettered `CAPABILITY_DISABLED` and the claim stays held without a
terminal outcome; no dead-letter replay executor exists. The owner approved Alternative A **only as an interim manual control** for that case. This
block adds it as the smallest governed wrapper around the engine's existing scoped primitive, `AuthorizedActionExecutionService.runDue`.

## 2. Usage

```
POST /v1/businesses/{businessId}/execution-recoveries
Headers: Authorization, x-tenant-id, x-workspace-id, Idempotency-Key
Body:    { "actionType": { "code": "inventory_reorder_policy_update", "schemaVersion": "1" },
           "reason": "claim stranded after the kill switch was lifted", "limit": 10 }      // limit optional, 1..25 (default 10)
200:     { "businessId", "actionType", "attempted": n,
           "results": [ { "claimId", "state": "TERMINAL", "outcome", "reasonCode", "executionId", "replayed" } |
                        { "claimId", "state": "RETRY", "reasonCode", "attemptNumber" } ] }
```

Typical operation: re-enable the business (or clear the kill switch), then call this once; repeat only if a result is `RETRY`.

## 3. Rules (all pinned by tests)

- **Permission**: the existing `bo:admin` (nothing invented), enforced by the route and re-checked by the service. Idempotency-Key and an active subscription are required.
- **Scope**: ONE business (path, verified against the authenticated tenant/workspace) and ONE action type per request. The body is strict: it cannot name a claim, tenant, workspace, owner, state or permission. The awaiting-claims read runs in the caller's tenant transaction (RLS); no cross-tenant listing, no admin connection, no new grant.
- **Same service, same rules**: it calls the engine's `runDue`, so the worker path's rules apply unchanged: a claim is driven only when due (60 s, or its backoff), with a **fresh ABA status/authority check under the target lock**, the governed gate, and a terminal claim is **never re-driven**. It cannot create a claim and adds no retry policy (the engine still ends a claim at attempt 3).
- **Never bypasses the gate, never terminalizes on a closed one**: the gate is checked first; a closed gate is `409 ClaimRecoveryOperatorError` before anything is audited or attempted (the engine would otherwise record a held claim as a spent REFUSED).
- **Audited**: a user-actor audit row `bo.claim_recovery.requested` before anything runs and `bo.claim_recovery.completed` (with per-claim results) after, entity `authorized_action_recovery_request`; the engine writes its own execution/attempt audit rows as always.
- **Bounded and idempotent**: at most 25 claims per request; the same Idempotency-Key replays the stored response.

## 4. Architecture

| Piece | Where |
|---|---|
| Governed request (permission, validation, gate, audit, per-claim result) | `business-operations-runtime/src/authorized-action/ClaimRecoveryOperatorService.ts` |
| `runDue` business/action-type narrowing | `AuthorizedActionExecutionService.runDue`, `AuthorizedActionExecutionRepository.claimsAwaitingExecution(filter)`, `recordOperatorAudit` |
| Route + strict schema | `apps/api/src/routes/claimRecovery.ts`, `apps/api/src/schemas/claimRecovery.ts` |
| The ONE join of engine and ABA status provider (built per request for the acting user, same governed gate) | `apps/api/src/claimRecoveryComposition.ts` |

BO owns the control; ABA stays outside it (the status provider is supplied only by the API composition root, as for the issuer's announcer).
The worker package never references it.

## 5. Dependencies, configuration, residuals

- No new dependency or migration. `OPERATOR_RECOVERY_STATUS_MAX_AGE_MS = 5000` is the ruled O-2 value, the same the worker is configured with.
- The control drives claims now rather than waiting for signals; it is a manual, rare, audited action and not a schedule.
- A claim whose gate stays closed remains held (by design); there is no force option.

## 6. Tests

- `apps/api/tests/claimRecovery.integration.test.ts` (10, real PostgreSQL + Fastify + RLS): happy path with audit, due rule, terminal never re-driven, idempotent replay, authentication/permission/idempotency, closed gate (not activated, disabled, kill switch) leaves the claim unterminalized and recoverable after reopening, revoked authority and unavailable status, cross-tenant 404 + strict body, same-workspace sibling untouched, validation.
- `packages/event-worker/tests/p0-6h.architecture.test.ts` (8): only `runDue` caller, worker unaware, permission/route governance, scope, gate-before-audit-before-engine, audit order and bound, ABA joined only in the composition root, no migration.
- Amended (not weakened): P0-6c/6e/6f/6g guards now name the operator service as the only `runDue` caller and the API composition root as the second engine construction site; routes still may not execute.

## 7. Future extension

Automatic bounded re-arm of a gate-deferred recovery signal (owner ruling needed on how long a closed gate may defer recovery); a read-only listing of held claims for operators.
