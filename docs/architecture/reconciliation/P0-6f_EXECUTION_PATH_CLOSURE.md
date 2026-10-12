# P0-6f — Execution-path closure: ABA announcer, activation delivery safety, stranded-claim finding

Status: implemented on branch `remediation/p0-6f-path-closure` (DRAFT PR). Repository support only: no deploy, no live migration, no real business activated, no migration added (head stays 0195). Owner rulings applied: `bo:admin` stays the activation permission; stranded-claim recovery is a PRE-PRODUCTION blocker and is **not implemented here** (owner decision required, section 5).

## 1. The root gap (Block 1)
The announcer, the gate and the consumer all existed; nothing joined them in production.
- `AbaAuthoringService`'s default issuer was `new AuthorizedActionPackageIssuer()` - **no announcer** - and the API root registered the authoring routes without one. So issuance never wrote `control_loop.action.authorized@1`; only tests did.
- ABA may not import Business Operations, so the activation gate (a BO implementation) could not be built inside ABA. The missing edge is a **composition-root** edge: the API root must hand the issuer an announcer whose gate is BO's governed gate, supplied as an interface.

## 2. What was wired (Block 2)
`apps/api/src/abaPackageAnnouncement.ts` (the one composition point) builds the issuer with `ActionAuthorizedAnnouncer` whose gate is a **factory over the issuing context**: `ctx => GovernedExecutionGate(...)`. `app.ts` passes it as `issuer`. ABA announces authorization only: the sealed package's reference-only notification goes through the **existing outbox inside the issuance transaction**, with the deterministic event id. Gate closed (no activation, kill switch, registry, or invalid delivery) = the package stays ISSUED and an identical issue request announces it once the business is activated. BO still validates, claims and executes; ABA never calls BO, reads its tables or mutates inventory.
Announcer change (workflow): `gate` may be a factory `ctx => gate`; a factory that throws, or any answer other than exactly `true`, is closed.

## 3. Activation / subscription safety (Block 3)
Invariant: **an activation is never observably ENABLED unless its delivery subscriptions are valid.** Proven two independent ways, both fail-closed:
- **A. Atomic.** `ExecutionActivationService.setActivation` runs the version-chained ENABLED row, the idempotent provisioning of both subscriptions, a read-back verification and the audit row in ONE transaction. Any failure throws, the transaction rolls back, and the business stays CLOSED with no subscriptions left behind (tested: first create fails, second create fails, conflicting subscription, foreign-scope name holder, paused/disabled/failed subscription, different retry policy, audit failure, verification failure, repeated and 8 concurrent enables).
- **C. Runtime readiness.** `GovernedExecutionGate` additionally requires both subscriptions to exist, be `active`, and equal the pinned specs (pattern, destination, version `1`, the ruled 3 x 1s/5s/15s retry policy) at EVERY evaluation. A later pause, edit or removal closes the gate; restoring reopens it.
Hardening: `EventSubscriptionRepository.ensureOnClient` now also refuses an existing subscription that is not active or whose retry policy differs (previously only pattern/destination/versions); `verify`/`verifyOnClient` added. A refusal is `409 SUBSCRIPTIONS_INVALID` on the API. Subscription presence alone never opens anything.

## 4. Real end-to-end proof (Block 6)
`apps/api/tests/p0-6f-execution-path.e2e.test.ts`: the production `buildApp` (with the ABA announcer), the real ABA authoring chain over HTTP (governance, approver authority, decision, BO evaluation verified by the real verifier, capture, owner, boundaries, issuance), activation over HTTP as the owner, the worker composition with the REAL ABA status provider / package source / consumption recorder, real BO, real OM, PostgreSQL with RLS. No BO row for the package is written by the test. Proves ISSUED -> announced (reference-only) -> receipt -> claim -> ABA CONSUMED mirror carrying BO's receipt id -> fresh status -> mutation -> sealed evidence digest equals the package digest lineage -> same-transaction executed event -> OM EXECUTION_VERIFIED / OUTCOME_PENDING; learning eligibility false. Negatives: no activation, missing subscription (two cases), failed provisioning, kill switch on the ABA edge, revoked authorization (real ABA revoke route; refused at BO intake for AUTHORITY_REVOKED), duplicate announcement, duplicate BO notification, concurrent workers, OM unavailable, and the stranded-claim reproduction.

### Real defect found and fixed by the real end-to-end test
The real BO evaluator records snapshot reorder values as `numeric` text (`"170.0000"`); the P0-6c baseline reader accepted only JSON numbers, which the P0-6c fixtures used. **Every real modified approval would have been REFUSED(NO_BASELINE_EVIDENCE).** Fixed in the consumer (`Decimal.fromSnapshotValue`: plain decimal text or finite number; everything else rejected). Evaluation records are immutable and were not changed.

## 5. Stranded-claim finding (Blocks 4-5) - OWNER DECISION REQUIRED
**Scenario (reproduced in the end-to-end test):** delivery attempts 1-2 are spent before the claim (status not obtainable yet); attempt 3 claims, but the final authority check cannot decide; the outbox dead-letters the notification (`RETRIES_EXHAUSTED`). Result: BO holds the single-use claim, no terminal execution exists, nothing is mutated, and no worker re-drives it. Cause: the **outbox delivery budget (3) is shared** between pre-claim intake retries and post-claim engine retries, while the engine counts only its own attempts.
**Can existing infrastructure recover it? No, not automatically.**
- `runDue` (the scoped recovery primitive) works - the test recovers the claim with it (fresh ABA status, 60 s threshold, terminal never re-driven) - but **nothing calls it**, and the worker finds scopes only from `events.outbox_events` rows (a dead-lettered notification is no longer dispatchable).
- Dead-letter replay is not an option: no replay executor exists, and the replay policy (`ReplayAuthorization`) allows action events only as DELIVERY_ONLY evidence with an ABA reference - it deliberately forbids turning a replayed action event into a fresh command.
- No scheduled reconciliation worker exists.
Recovery therefore needs a new capability. Bounded alternatives (all reuse `runDue`; none adds a retry policy):

| | A. Operator-invoked scoped recovery | B. Worker claim-scan | C. Durable timer in the existing outbox |
|---|---|---|---|
| What | A command in the worker package: `recover --tenant T --workspace W` calls `runDue` for ONE explicit scope | A second scope-discovery query over BO claims without an execution, driving `runDue` per scope each cycle | When BO takes a claim it also writes a `recovery_due` outbox row (available_at = claimed + 60 s); the existing worker/consumer re-drives `runDue`-equivalent for that claim and re-arms until terminal |
| Ownership | BO engine, operator-run | BO engine, hosted by the event worker | BO (new internal event + consumer), DATA transport |
| Security / tenancy | No new privilege; explicit scope argument; audited operator action | **New cross-tenant read**: the discovery role needs SELECT on `authorized_action_claims`/`executions` ids (BYPASSRLS) - a new surface | No new privilege; per-scope rows; reuses RLS and existing discovery |
| Automatic | No (MTTR = operator) | Yes | Yes |
| Cost | Smallest | New grant + discovery source + ops runbook | New event contract + subscription + intake change (claim path) |
| Residual | A claim stays stranded until noticed | Broad read path to govern | Recovery event itself could dead-letter (re-arm on retry bounds it) |
**Recommendation: C** (no new cross-tenant privilege, automatic, inside existing infrastructure), with **A** as the interim operational control until C ships. Both are pre-production; B only if the owner accepts the new read surface.

## 6. Other findings
1. The outbox treats an event with no subscriber as published; mitigated because subscriptions are validated at activation and re-validated by the gate at every evaluation.
2. The `ports` seam of the worker composition is still used by the P0-6e scripted test; P0-6f's principal proof uses none (one named test wraps the real status provider to withhold answers).
3. CI observability (separate PR recommendation): upload the vitest report as a workflow artifact and print a failure summary at the end of the Test step.

## 7. Not done (deliberately)
No deploy, live migration or real activation; no stranded-claim recovery (decision pending); no new action type; no outcome measurement or CL learning; no second event bus, engine, retry policy or outbox; no owner backfill; no data-capture A/D; no final audit; no CI change.
