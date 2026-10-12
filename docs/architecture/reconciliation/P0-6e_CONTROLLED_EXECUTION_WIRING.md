# P0-6e — Controlled execution wiring, governed activation, end-to-end authorized-action flow

Status: implemented on branch `remediation/p0-6e-controlled-wiring` (DRAFT PR). **Repository support only.** Nothing is applied to a live database, nothing is deployed, no business is activated, no secret or production configuration is touched, and the production default stays CLOSED.

## 1. Purpose
Make the locked path functionally executable in the application architecture while it stays fail-closed:

```
ABA authorization -> AuthorizedActionPackage -> control_loop.action.authorized@1
  -> worker -> BO consumer -> BO intake receipt -> single-use BO claim -> (ABA CONSUMED mirror)
  -> governed gate -> BO execution engine -> FRESH ABA authority under the target lock -> reorder mutation
  -> ExecutionEvidence (execution-evidence/1) + operations.action.executed@1 (same transaction)
  -> worker -> OM consumer -> EXECUTION_VERIFIED / OUTCOME_PENDING
```

## 2. Ownership (unchanged)
| Layer | Owns | Does not |
|---|---|---|
| ABA | authorization truth, package lifecycle/status | execute, claim, activate |
| BO | claim, execution, the reorder fields, evidence, the activation record | decide authorization or outcomes |
| DATA | outbox, ledger, subscriptions, delivery | decide anything |
| OM | verifies the execution fact | execute, write BO state, claim an outcome |
| CL | nothing yet | learn from anything short of `OUTCOME_VERIFIED` |

## 3. What was wired
- **One trigger.** `AuthorizedActionNotificationConsumer` (BO) hands the claim id to the engine after intake claimed and the ABA mirror was attempted. It is the only caller of `executeClaim`; `runDue` has no caller. The engine is constructed once, in the worker composition root.
- **One gate, three independent keys** (planning decision 16): the capability registry (key 1), the per-business activation record (key 2), the global kill switch (key 3). The same gate instance governs the consumer (before the claim) and the engine (again, under the target lock).
- **Registry:** exactly `inventory_reorder_policy_update@1`. Capability only: it neither activates nor authorizes.
- **Retries/recovery ride the existing outbox.** An engine result of "cannot decide yet" is thrown as a retryable `DeliveryError`; the outbox redelivers under the subscription's retry policy (3 attempts, 1 s / 5 s / 15 s — the ruled policy, asserted equal to BO's engine constants). The engine counts its own attempts and writes the terminal outcome itself on the last one. A worker crash is recovered by the dispatcher's existing stale-claim recovery (60 s). No scheduler, queue or second retry policy was added.

## 4. Activation model (migration 0195)
`business_operations.execution_capability_activations`: append-only, version-chained per (business, action type, schema version), RLS forced, tenant + workspace + business scoped, DB-clock time, actor, permission and reason recorded. **No row, or a latest DISABLED row, is CLOSED.** No seed, no backfill, no wildcard.
- It answers only "may this supported type execute for this business?". It replaces none of: ABA authorization, package status verification, the BO claim, authority freshness, preconditions, execution boundaries.
- **Control surface:** `PUT/GET /v1/businesses/:businessId/execution-activations`. Changing state needs the **existing** permission `bo:admin` ("Administer business operations configuration"; held by the owner and admin roles — not by members, viewers or ABA approvers). Server-authoritative (tenant, workspace and actor come from the authenticated context; the strict body can name nothing else), idempotent (Idempotency-Key + exact no-op), audited atomically (`bo.execution_activation.enabled|disabled`). Enabling provisions the two delivery subscriptions idempotently. Disabling is always allowed.
- **Kill switch:** `INFINICUS_EXECUTION_KILL_SWITCH`. Absent or `0/false/off/no` = not engaged; any other value (including a typo) = engaged. It can only remove capability.

## 5. Configuration
| Setting | Where | Notes |
|---|---|---|
| `INFINICUS_EVENT_WORKER_EXECUTION_STATUS_MAX_AGE_MS` | worker env | **required, no default** (ruling O-2: 5000 in v1); judged immediately before the mutation, under the target lock |
| `INFINICUS_EXECUTION_KILL_SWITCH` | worker env | optional; can only remove capability |
| activation record | database | the only way to open a business; written only through the audited administration path |

## 6. Live activation runbook (NOT performed here; a separate owner decision)
1. Re-verify the live Supabase migration head (never assume it; owner ruling O-15). Apply 0193–0195 through the normal migration gate.
2. Deploy the worker with the required environment, kill switch absent.
3. Enable ONE business through the API as a `bo:admin` user. This provisions the subscriptions. Observe: audit row, subscriptions, a first authorized package executing end to end.
4. To stop: disable the business (audited) or engage the kill switch (all businesses).

## 7. Findings for the owner (flagged, not decided silently)
1. **Permission choice.** Two existing permissions could apply: `bo:admin` (chosen: per-business BO configuration, matches ruling O-11 "appropriate existing admin permission") and `platform:admin` (owner-only; used for declared currency). Switching is a one-constant change (`EXECUTION_ACTIVATION_PERMISSION`).
2. **Retry driver.** There is no scheduler for the engine's own `runDue`. Retries and crash recovery ride outbox redelivery of the authorized notification. Residual: if the notification itself is dead-lettered (three failed deliveries) while a claim has no outcome, nothing re-drives that claim automatically; it would need an explicit replay or a future recovery runner (which needs a narrowly granted cross-tenant discovery read, i.e. new infrastructure). Not built here.
3. **Zero-subscriber publication.** The outbox treats an event with no matching subscription as published. An executed event announced before OM's subscription exists is not replayed later. Provisioning subscriptions at activation (before any execution can occur) avoids this; a business executed without activation cannot occur because the gate is closed.
4. **ABA-side announcement.** No production composition constructs the ABA announcer (`ActionAuthorizedAnnouncer`); packages are not yet announced from the API. That producer wiring, and its gate, is the missing first hop of the live flow and was not part of this block.
5. **End-to-end fidelity.** The end-to-end test scripts the three ABA-owned ports (status, package source, consumption mirror) because a package targeting a real BO item with BO evaluation evidence is built by the BO execution-world fixture, not issued through ABA's authoring chain. Every other component is the production composition on real PostgreSQL.

## 8. Not done (deliberately)
No deploy; no live migration or live data change; no activation of any business; no additional action type; no outcome measurement or CL learning; no change to ABA/ADI ownership; no second writer, outbox, retry system or scheduler; no owner or permission backfill; no legacy endpoint retirement; no CI redesign.

## 9. CI observability recommendation (separate PR)
The earlier P0-6d `validate` failure could not be diagnosed because the failing test output was not retrievable. A small, isolated CI-hardening PR could upload the vitest report (JUnit or JSON reporter) as a workflow artifact and print a failure summary at the end of the Test step. Not mixed into P0-6e.

## 10. Extension notes
A second action type needs: an adapter in BO, an entry in the registry, an entry in `OM_VERIFIABLE_ACTION_TYPES`, its own e2e proof (the registry guard requires the e2e suite to exist), and its own owner-approved activation. Nothing else in the pipeline changes.
