# P0-6b — `ACTION_AUTHORIZED` pipeline: event, dispatcher worker, BO consumer

Programme Phase 4 (rulings O-1, O-3, O-9, O-11 gate semantics). The pipeline ends at **BO intake + single-use claim + ABA `CONSUMED` mirror**. It executes nothing and changes no inventory. `PRODUCTION_SUPPORTED_ACTION_TYPES` stays empty. Nothing is deployed or enabled.

```
ABA issuer ──(same transaction, gated)──▶ outbox row ──▶ worker: claim ▶ contract check ▶ ledger ▶ subscription ▶ delivery attempt
   ▶ BO consumer: inbox ▶ pull sealed package (ABA source port) ▶ existing intake (ABA status provider, claim) ▶ ABA CONSUMED mirror
```

## Pieces
| Piece | Where | Notes |
|---|---|---|
| `control_loop.action.authorized@1` (alias `ACTION_AUTHORIZED`) | `event-contracts/src/action-authorized.ts` | **reference-only, closed shape** (package id/version/digest/scope/action type/level/expiry/decision/issuedAt); any extra key (body, parameters) is rejected. Deterministic event id and idempotency key `aap:{id}:{version}`. Registered explicitly by the composition root |
| Execution capability gate | `handoff-contracts` `ExecutionCapabilityGate`, `DENY_ALL_EXECUTION_GATE` | one control for producer **and** consumer; closed (or throwing) = closed; the governed implementation is P0-6e |
| Producer | `workflow/ActionAuthorizedAnnouncer.ts` + optional `announcer` on the issuer | runs **inside the issuance transaction** (new issue and identical replay); gate closed ⇒ no outbox row; `available_at` = execution-window start (BO refuses early claims); `enqueueIfAbsent` ⇒ at most one row per package version |
| Dispatcher | `database/eventing/OutboxDispatcher.ts` | claims **only configured event types** (legacy rows untouched) ▶ contract validation ▶ immutable ledger (idempotent) ▶ matching `in_process` subscriptions ▶ delivery attempt per subscription ▶ publish, or retry with the subscription backoff, or dead-letter (non-retryable, contract rejection, no consumer, attempts exhausted). Recovers rows abandoned `processing` after a claim timeout |
| Migration 0190 | `outbox_events.claimed_at` | additive, nullable, no backfill; historic rows are never treated as stale |
| BO consumer | `business-operations-runtime/…/AuthorizedActionNotificationConsumer.ts` | inbox-idempotent; re-checks event scope; closed gate ⇒ non-retryable `CAPABILITY_DISABLED` (dead letter; replay needs governed approval); pulled package must match id/version/digest; transient intake refusals (`STATUS_UNAVAILABLE`, `STATUS_UNVERIFIED`, `AUTHORITY_UNVERIFIABLE`, `EXECUTION_WINDOW_NOT_OPEN`) retried, every other refusal is a handled final outcome; ABA mirror after claim (unrecordable mirror is not a delivery failure) |
| Worker library | `packages/event-worker` | scope discovery port, worker cycle/loop, strict env config (no defaults), composition root (the only place ABA and BO implementations are joined) |
| Worker process | `infrastructure/deployment/event-worker/` | Dockerfile, compose overlay behind profile `event-worker` (never started by default), README with role provisioning. **Separate process; the API never polls (O-1)** |

## Safety defaults (every one is OFF/closed)
- No `announcer` ⇒ the issuer emits nothing (the production API composition is unchanged).
- Gate defaults to deny-all in the announcer, consumer and worker composition.
- BO capability registry defaults to the empty production registry ⇒ intake refuses `ACTION_TYPE_UNSUPPORTED_BY_EXECUTOR`.
- No subscription row ⇒ nothing is delivered. Subscriptions are per business (`subscriber_name` is platform-unique, so it is `bo.authorized_action_intake@<workspaceId>`).
- The worker process refuses to start without every setting; thresholds are deployment values.

## Retry (O-3 values for this subscription)
Subscription `retryPolicy` `{maxAttempts: 3, backoffSeconds: [1, 5, 15]}`; the backoff array is indexed per attempt (last value repeats). Execution-claim recovery after 60 s is P0-6c, not here.

## Accepted limits / not done
- Delivery is at-least-once, not exactly-once; consumers are idempotent (inbox, intake replay).
- **Cross-tenant discovery** needs a separate narrowly-granted read connection (`INFINICUS_EVENT_WORKER_DISCOVERY_DATABASE_URL`; secret-inventoried). The API role cannot enumerate tenants. Provisioning is an operator step (migrations carry no GRANT/role statements). Without it the worker does nothing.
- Dead-letter replay approval flow for `CAPABILITY_DISABLED` uses the existing BUILD-33 mechanism; no new UI.
- Not applied to live Supabase; no deployment performed.
