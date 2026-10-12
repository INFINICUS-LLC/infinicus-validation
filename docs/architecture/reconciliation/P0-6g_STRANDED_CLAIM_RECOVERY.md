# P0-6g - Durable stranded-claim recovery (Alternative C)

Status: implemented on a draft PR; **not activated, not deployed, no live database change, no migration.** Production activation remains OFF
(the three-key gate is closed until an administrator enables a business, and no activation row exists anywhere).

## 1. Purpose

A **claim** is Business Operations' canonical consumption fact for an authorized-action package. Until now only the delivery of the
`control_loop.action.authorized@1` notification drove a claim to execution. The outbox delivery budget (3 attempts) is shared between
pre-claim intake retries and the engine's post-claim retries, so a claim could be left with **no terminal execution outcome** and nothing
would ever re-drive it (reproduced in `p0-6f-execution-path.e2e`). P0-6g makes that recovery durable, automatic and tenant-scoped, inside the
existing infrastructure.

## 2. Architecture

```
BO intake: receipt + single-use claim  --(same transaction)-->  outbox row operations.authorized_action.recovery_due@1
                                                                 id = f(claimId), available_at = claimedAt + 60 s
existing event worker (finds the scope from that outbox row, like any event)
   -> OutboxDispatcher -> subscription bo.authorized_action_recovery@<workspace>
   -> ClaimRecoveryConsumer: resolve the EXISTING claim in the delivery scope
        terminal outcome?  -> done (spent; never re-driven)
        gate closed?       -> non-retryable CAPABILITY_DISABLED (nothing executes)
        else               -> AuthorizedActionExecutionService.executeClaim(claimId)   (the ONE engine)
              TERMINAL -> done      RETRY -> retryable DeliveryError (outbox redelivery, same ruled 3 x 1s/5s/15s)
```

Ownership is unchanged: ABA authorizes/announces only; **BO** owns claim, execution, evidence and the recovery signal; **DATA** owns the outbox and
transport; OM verifies; CL learns nothing. The signal is a nudge: it creates no claim, carries no package body, parameters or authority, and the
engine re-establishes everything (gate, registry, BO's immutable package copy, **current authority/status under the target lock**) before any
mutation.

| Piece | Where |
|---|---|
| Event contract `operations.authorized_action.recovery_due@1` (closed, reference-only payload; deterministic id per claim) | `packages/event-contracts/src/authorized-action-recovery.ts` |
| Third pipeline subscription (same ruled retry policy) | `execution-pipeline-subscriptions.ts` |
| Claim-time scheduling (in the claim transaction, existing outbox, `enqueueIfAbsentOnClient`) | `business-operations-runtime/src/authorized-action/ClaimRecoveryScheduler.ts`, hook `onClaimed` in `AuthorizedActionIntakeRepository` |
| Recovery consumer (resolves the claim, calls only `executeClaim`) | `.../ClaimRecoveryConsumer.ts` |
| Claim read (identity + terminal outcome, scope-bound by RLS) | `AuthorizedActionExecutionRepository.getClaimState` |
| Worker wiring (same executor, same gate; event type swept) | `packages/event-worker/src/compose.ts` |

Event naming: the planned spelling `operations.authorized-action.recovery-due` is invalid under the platform `EVENT_NAME` rule (underscores only), so
the canonical type is `operations.authorized_action.recovery_due`.

## 3. Guarantees (each pinned by a real-PostgreSQL test or an architecture guard)

- **Atomic with the claim**: no claim without its signal (a failing schedule rolls the claim and receipt back); replays and refusals write none; one signal per claim.
- **Threshold**: due at `claimedAt + EXECUTION_CLAIM_RECOVERY_MS` (60 s, the ruled value); not delivered earlier.
- **Recovers a really stranded claim once**: one mutation, one `ExecutionEvidence`, one `operations.action.executed@1`, no second claim, no re-mirror.
- **Terminal is spent**: SUCCEEDED/REFUSED/FAILED claims are never re-driven; REFUSED/FAILED still need a new authorization. (Defence in depth: the consumer short-circuits, and the engine replays a stored outcome.)
- **Final authority/status re-check still mandatory** (revoked authority meanwhile -> terminal REFUSED(AUTHORITY_REVOKED), nothing mutated); a closed gate recovers nothing.
- **No second retry policy**: the engine bounds attempts at 3 total and writes the terminal outcome itself; the signal's redelivery is the same ruled outbox policy.
- **Idempotent and concurrency-safe**: three workers plus a direct engine call yield one execution; a duplicate delivery changes nothing (inbox + engine per-claim lock).
- **Cannot create or borrow a claim**: a signal naming no claim, another scope's claim, or a claim it does not describe is dead-lettered before the engine is asked.
- **No global scanner, no new cross-tenant read or grant, no migration**: scopes are still discovered only from `events.outbox_events`.
- **Activation requires it**: the recovery subscription is part of the one list activation provisions atomically and the gate re-verifies on every evaluation.

## 4. Dependencies and configuration

None new. It uses the existing outbox, dispatcher, worker, inbox, subscriptions table and engine. The recovery threshold is the existing
`EXECUTION_CLAIM_RECOVERY_MS`; the engine's `executionStatusMaxAgeMs`, the worker config and the kill switch are unchanged.

## 5. Residuals and operations (owner-visible)

1. **Recovery signal that is itself dead-lettered.** If the gate is closed (business DISABLED or global kill switch) when the signal falls due, it is dead-lettered
   `CAPABILITY_DISABLED` (correct: nothing executes), and the claim stays held without a terminal outcome until an operator acts. No dead-letter replay executor
   exists, so this needs the **interim operator control** below. This is deliberate (an owner-closed gate must not be bypassed) but it is the one remaining
   path to a held claim.
2. **Interim operator control (Alternative A) - documented, NOT built here.** The scoped primitive already exists: `AuthorizedActionExecutionService.runDue(ctx, { limit })`
   for ONE explicit tenant/workspace, `bo:admin`-authorised, with a fresh authority check and the terminal-never-re-driven rule. A command/route that wraps it
   (explicit scope argument, audited operator action, no cross-tenant listing) was approved only as an interim control; building it is a separate small block.
   Until then a stranded claim after a long gate closure is recovered by an engineer running `runDue` for that scope.
3. **Claims created while the gate is closed** do not exist (the notification consumer checks the gate before intake), so closure never creates stranded claims; it can only strand a signal that was already due.
4. **One extra outbox row and ledger entry per claim**, delivered as a no-op when the claim already completed. This is the price of a durable, scanner-free timer.
5. A recovery delivery overlapping the original delivery serializes on the engine's per-claim lock; it can spend one of the engine's three attempts earlier than the original schedule would, never more than three in total.
6. Replay of a dead-lettered recovery signal is not a business command (the engine re-checks everything), so `ReplayAuthorization` is unchanged; no replay executor exists in any case.

## 6. Testing

- `packages/event-contracts/src/__tests__/authorized-action-recovery.test.ts` (7): contract, closed payload, ids, envelope, subscription spec.
- `packages/event-worker/tests/ClaimRecovery.e2e.test.ts` (13, real PostgreSQL, real components, scripted ABA ports): atomic scheduling, threshold, stranded-claim recovery, bounded retries, terminal never re-driven, revoked authority, closed gate, concurrency, duplicate delivery, forged/foreign/mismatching signals.
- `packages/event-worker/tests/p0-6g.architecture.test.ts` (11): no scanner/grant/migration, one executor, cannot create a claim, written only with the claim, terminal short-circuit order, no second retry policy, activation requires the subscription, internal-only contract.
- Updated, not weakened: the P0-6b/6c/6e/6f guards now name the recovery consumer as the engine's only other driver and the recovery scheduler as the only other outbox writer in BO; the activation tests expect three subscriptions.

## 7. Future extension

Operator command for Alternative A; a bounded re-arm for a signal dead-lettered by a closed gate (needs an owner ruling on how long a closed gate may defer recovery); data-capture and outcome-effectiveness blocks remain separate and untouched.
