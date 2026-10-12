# P0-6d — Execution evidence contract, `operations.action.executed@1`, and OM execution verification

Status: implemented on branch `remediation/p0-6d-execution-evidence` (DRAFT PR). Nothing is applied to a live database, nothing is activated, no worker or capability is enabled, and P0-6e has not started.

## 1. Purpose
Close the loop between Business Operations (BO) and Outcome Monitoring (OM) with one question only: **did BO really do what it says it did?** Execution FACT and outcome EFFECTIVENESS are separate. BO states the first, never the second. OM verifies the first and records the second as PENDING / INCONCLUSIVE until a governed measurement model exists.

```
ABA (authorizes) -> BO intake -> BO claim -> fresh authority -> BO mutation
   -> ExecutionEvidence (sealed, BO-authored)  --+
   -> operations.action.executed@1 (outbox, same transaction)  [transport: DATA]
   -> OM consumer -> pulls evidence through the BO read port -> verifies -> OM verification record
   -> (CL: nothing, until OM verifies an OUTCOME)
```

## 2. Architecture
| Piece | Location | Owner |
|---|---|---|
| `execution-evidence/1` types, closed-shape validator, digest, seal, state vocabulary, learning gate | `packages/handoff-contracts/src/execution-evidence/` | shared contract (pure, imports only itself) |
| `operations.action.executed@1` payload, deterministic event id, contract registration | `packages/event-contracts/src/action-executed.ts` | shared contract |
| Evidence builder, publisher, read port implementation, engine wiring | `packages/business-operations-runtime/src/authorized-action-execution/` | BO |
| Same-transaction outbox insert on the caller's client | `OutboxRepository.enqueueIfAbsentOnClient` | eventing (BUILD-33) |
| Verification service, consumer, initial-outcome rule, observation-authority data | `packages/outcome-monitoring-runtime/` | OM |
| Verification table (append-only, RLS) | migration `0194`, repository `ActionExecutionVerificationRepository` | OM |
| Vocabulary alignment `NOT_APPLIED -> NOT_APPLICABLE` | migration `0193` | BO table, vocabulary only |
| Worker composition | `packages/event-worker/src/compose.ts` | composition root |

## 3. Dependencies and configuration
- Migration head moves 0192 -> 0194. Both migrations are idempotent, self-register in `_migrations`, contain no GRANT/REVOKE/role statements, and edit no earlier migration.
- The event-worker already runs as a separate process. It now also dispatches `operations.action.executed`. The BO engine itself stays **unwired** and `PRODUCTION_SUPPORTED_ACTION_TYPES` stays **empty**, so a default-built system produces no executed events.
- A subscription per scope is required for delivery: `subscriber_name = om.execution_verification@<workspaceId>`, `event_pattern = operations.action.executed`, `destination_reference = om.execution_verification`, `supported_versions = ['1']`. Creating subscriptions is an activation step (P0-6e) and is not done here.

## 4. Atomicity and idempotency
The engine writes the terminal execution row, the evidence, the audit event **and** the outbox row in one transaction. A committed execution always has its event; a rollback leaves none (tested by forcing the publisher to fail: no execution row, no mutation, no event, a RETRY result). The event id is a deterministic UUID derived from the execution id, so retries, replays and 8 concurrent callers announce an execution once. OM's verification is unique per (business, execution); a different digest for an already verified execution is a conflict, not an overwrite.

## 5. Usage
- BO: construct `AuthorizedActionExecutionService` as before; `eventPublisher` defaults to `OutboxExecutionEventPublisher`.
- OM: `new ActionExecutedConsumer({ verification: new ExecutionVerificationService({ evidence: <ExecutionEvidenceReader>, supportedActionTypes: OM_VERIFIABLE_ACTION_TYPES }) })`.
- Learning gate: `learningEligibility({...})` is eligible only for `EXECUTION_VERIFIED` + `OUTCOME_VERIFIED` + `SUCCEEDED` + `APPLIED`. It has **no production caller yet** (guarded by a test), by design.

## 6. Deviations and notes
- The authorization named the mutation result `NOT_APPLICABLE`. P0-6c had shipped `NOT_APPLIED` in the BO table. 0193 aligns the database to the authorized vocabulary; the historical planning document's `NOT_APPLIED` mention is left as history.
- The validator requires full authority proof (verification times, answer digest, provider) only for a SUCCEEDED execution. A refusal can occur before authority was fully established (for example a package revoked after the claim), and the evidence records exactly what was known rather than inventing proof.

## 7. Future extension
- A new evidence version is a new contract string (`execution-evidence/2`) added to the supported list; OM rejects versions it does not know.
- A second action type needs: an adapter in BO, an entry in `OM_VERIFIABLE_ACTION_TYPES`, and its own measurement-authority data. Nothing else in the pipeline changes.
