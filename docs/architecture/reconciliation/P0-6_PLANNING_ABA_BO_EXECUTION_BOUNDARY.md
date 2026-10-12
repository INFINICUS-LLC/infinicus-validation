# P0-6 planning — ABA → BO execution boundary for `inventory_reorder_policy_update@1`

Status: **PLANNING / RECONCILIATION — owner rulings recorded (§25).** No code, no migration, no production behaviour in this record. P0-6 stays OFF.
The blocks in §21 are authorized by the owner's high-autonomy programme mandate (rulings O-1..O-15 below); production activation, live
migrations and merges remain owner-only gates.

Baseline surveyed (read-only): `main` = `3942be6` (#89), migration head **0187**, open PRs none, main CI green. **Live Supabase head was not
re-checked**: the Supabase connector available to this session lists no projects, so the last verified programme state (0169) is carried
unchanged and must not be assumed to have advanced or stayed the same.

Conventions used below: **[RULED]** = an existing owner ruling (cited); **[EXISTS]** = verified in the repository; **[MISSING]** = verified
absent; **[PROPOSAL]** = my recommendation, needs owner review; **[OWNER DECISION]** = cannot be settled without the owner (§25).

Locked flow (unchanged, no stage skipped):
`ADI → ABA → AuthorizedActionPackage → BO intake → BO claim/consumption → fresh pre-execution authority/status check → BO mutation → ExecutionEvidence → OM → CL`.
ApprovedAction alone is never execution authority; ABA authorizes, BO mutates.

---------------------------------------------------------------------------------------------------------------------------------------

## 1. Survey: what exists

| Area | Finding |
|---|---|
| Package issuance | **[EXISTS]** `AuthorizedActionPackageIssuer` (single sealer) builds from persisted authority; ends at a sealed `aap/1` package. Emits nothing, calls nothing in BO. |
| ABA package store | **[EXISTS]** `authorized_action_packages` / `_versions` / `_lifecycle_events` (0176). Lifecycle `ISSUED, REVOKED, SUPERSEDED, EXPIRED, CONSUMED`; one terminal fact per version (partial unique index); `CONSUMED` requires `consumption_receipt_id` (a soft reference to the BO receipt); `EXECUTED` is deliberately not a state. State is derived on the DB clock. |
| ABA status primitive | **[EXISTS]** `AuthorizedActionPackageRepository.getAuthoritativeStatus` (lifecycle, latest version, digest echo, ABA `verifiedAt`). It does **not** answer authority currentness. |
| Status provider port | **[EXISTS]** `AuthoritativePackageStatusProvider` + `AuthoritativeStatusAnswer { status, authority{CURRENT\|REVOKED\|UNVERIFIABLE, verifiedAt} }` in `handoff-contracts/status-provider.ts`. **[MISSING]** any production implementation (comment: "wired only in a later, separately authorized block"). |
| Authority currentness rule | **[EXISTS]** only inside `packageIssuancePolicy` (decision-time grant + `AUTHORITY_REVOKED` when the assignment is not active or the latest provenance entry is a revoke) and `DecisionWorkflowService.assertOwnerAuthorityStillProven`. Not callable as a service. |
| Package revoke | **[EXISTS]** `AuthorizedActionPackageRepository.revoke` (reasoned, attributable). **[MISSING]** any route or service calling it. Approver revocation route exists (`aba:admin`). |
| BO intake | **[EXISTS]** `AuthorizedActionIntakeService` + `AuthorizedActionIntakeRepository` + tables `authorized_action_receipts` (immutable verbatim sealed document), `authorized_action_claims` (UNIQUE package id + version, DB-clock guards: expiry, window-not-open, digest match), `authorized_action_intake_attempts` (CLAIMED/REPLAYED/REFUSED + refusal codes). All append-only, RLS forced (0180). **[MISSING]** any caller: no route, consumer or worker invokes it. |
| Pre-execution contract | **[EXISTS]** `validateForExecution` (scope, capability, window, status identity/freshness, lifecycle, current version) + `assessIntake` (adds authority freshness/state). `statusMaxAgeMs` is a required argument with **no default** (no ruled number). |
| Capability registry | **[EXISTS]** `PRODUCTION_SUPPORTED_ACTION_TYPES = Object.freeze([])`; guards in three architecture suites. With it empty a valid package is **received but never claimed** (`ACTION_TYPE_UNSUPPORTED_BY_EXECUTOR`). |
| Inventory writers | **[EXISTS]** `OperationalCommandExecutor` (single writer of `inventory_movements`; also updates `inventory_balances.quantity_on_hand`, with `FOR UPDATE` and `version = version + 1`) and `InventoryBalanceRepository` (`createBalance` inserts `reorder_point`/`reorder_quantity`; `adjustQuantity` updates quantity). **[MISSING]** any writer that updates `reorder_point`/`reorder_quantity` after creation, and any DB guard on those columns or `CHECK` on their sign. |
| Balance storage | **[EXISTS]** `inventory_balances` (unique item + warehouse, `numeric(18,4)` reorder fields, `version`, `updated_at` trigger). One balance per item per warehouse; the B2 evaluator already requires exactly one balance for the target item. |
| Eventing | **[EXISTS]** (BUILD-33, 0172/0173) outbox, canonical ledger (`source_domain` closed set includes `control_loop` and `operations`; `evidence_class` includes `ACTUAL`), delivery attempts, inbox `UNIQUE(event_id, consumer_name)`, subscriptions, dead letters, replay authorization, `BusinessEventContractRegistry`. **[MISSING]** any production caller of `OutboxRepository.claimBatch`/`CanonicalEventPublisher.publishClaimed`, any dispatcher/worker process, any registered production contract. Eventing is repository-level only: nothing delivers an event today. |
| `ACTION_AUTHORIZED` | **[MISSING]** as a contract or producer. **[RULED]** (D-5): use the package + a BUILD-33 ledger event referencing it + a BO receipt; "P0-6 performs the actual ABA→BO wiring". Name proposal in the Block 1 record: `control_loop.action.authorized` aliasing the manifest name. |
| `ExecutionEvidence` | **[MISSING]** as a contract, table or code (only comments and legacy browser-style docs). `ACTION_EXECUTED` is a manifest example name only. |
| OM side | **[EXISTS]** `outcome_monitoring.action_execution_observations` (free-form `detail jsonb`; comment: "never itself a record of having executed anything"). The legacy interim outcome route is **[RULED]** not ExecutionEvidence. **[MISSING]** any BO→OM execution-evidence handoff contract (`aba-to-om.ts` carries the approval decision, not execution). |
| Feature flags | **[MISSING]** no feature-flag infrastructure (the configuration package holds typed env config only). |
| Idempotency | **[EXISTS]** HTTP `Idempotency-Key` plugin (tenant + route + request hash); ledger idempotency key; inbox dedupe; intake uniqueness. |
| Audit | **[EXISTS]** `audit.audit_events` (append-only; each owning layer writes through its own wrapper on the caller's client); ABA approval audit trail (`package.issued`, `package.issuance_refused`). |
| Observability | **[EXISTS]** logger, error tracker, spans; human-created incident routes. No automatic incident creation. |
| Legacy ABA blocks 17/19/20/21 (execution adapter, controlled execution, compensation, execution evidence) | **[EXISTS]** as browser-style assets under `layers/approved-business-action/blocks`; **[RULED]** (Block 1 §9) not imported by the platform. They must not be wired: they would put execution/evidence ownership in ABA, contradicting the locked architecture. |

## 2. What is missing (summary)
1. A production ABA status provider (package lifecycle **and** authority currentness in one authoritative read).
2. A way for BO to obtain the sealed package document without reading ABA tables.
3. `ACTION_AUTHORIZED` contract, producer, delivery runtime and BO consumer.
4. An ABA-side recorder for `CONSUMED` (R-5: derived from BO's receipt; BO never writes ABA tables).
5. The BO execution adapter, execution/attempt tables, the reorder-policy mutation path and its guard.
6. The `ExecutionEvidence` contract, its event and the OM intake that verifies it.
7. An activation control with default OFF.
8. A BO evaluator for the package's runtime preconditions (the contract only carries `{code, operator, operand}`; no registry gives codes meaning).

---------------------------------------------------------------------------------------------------------------------------------------

## 3. Decision 1 — ABA status provider (production)

**Name/placement [PROPOSAL]:** `AbaPackageStatusProvider implements AuthoritativePackageStatusProvider`, in ABA code (`packages/workflow`), constructed at the
composition root and injected into BO services (the same pattern as `BoGovernanceEvidenceVerifier` in the opposite direction). BO imports only
the shared port and types from `handoff-contracts`; it never imports ABA persistence.

**One authoritative read.** A single ABA read transaction on the ABA database clock answers all of:
1. the package version exists in the **requested scope** (tenant/workspace/business) — any mismatch, or an unknown id/version, returns `null` (BO refuses; nothing about other scopes is disclosed);
2. exact `packageId`, `packageVersion` and `digest` are echoed, and the digest equals the stored one;
3. lifecycle derived exactly as `getAuthoritativeStatus` does (terminal fact wins; otherwise past expiry ⇒ `EXPIRED`; else `ISSUED`), plus `latestPackageVersion` (so `SUPERSEDED`/not-current is visible);
4. **authority state** from the same snapshot: the decision is still `approved`/`approved_with_modifications`; the approver assignment is active; the last provenance entry is not a revoke; an owner-role authority's ownership is still proven; and (see O-7) the Level 2 policy covering the type is still enabled. Any fact that cannot be established ⇒ `UNVERIFIABLE`; any revocation ⇒ `REVOKED`; only a positive proof ⇒ `CURRENT`.

**One rule, not two [PROPOSAL].** Extract the authority-currentness derivation from `packageIssuancePolicy` into a shared pure function used by both
the issuer and the provider, so issuance-time and execution-time judgments cannot drift (mutant: "REVOKED treated as CURRENT" must fail both).

**Never cached.** Each call reads current state. The provider is in-process (no HTTP route in P0-6). If BO is later a separate service, an
authenticated internal endpoint is a separate decision.

**Companion port [PROPOSAL]:** `AuthorizedActionPackageSource.get({packageId, packageVersion, scope})` returns the sealed document (same
authorization and scope rules). The event carries a *reference*; BO pulls the document through this ABA-owned port, then validates it itself
(contract + digest) before storing a receipt. The package body is not copied into the ledger, so the ledger never becomes a second
authorization record.

**Consumption mirror port [PROPOSAL]:** `PackageConsumptionRecorder.recordConsumed({packageId, packageVersion, digest, receiptId})` (ABA-owned
implementation writing the existing `CONSUMED` lifecycle fact with `consumption_receipt_id`). BO calls the port; BO still never writes ABA tables.

## 4. Decision 2 — `ACTION_AUTHORIZED` handoff

**Verdict: an outbox-backed BUILD-33 ledger event plus synchronous pull ports. No new mechanism.** [RULED, D-5] The package is the authorization
record; the event is notification/transport; the BO receipt is the idempotency/replay record.

| Aspect | Design [PROPOSAL unless cited] |
|---|---|
| Event | `control_loop.action.authorized@1` (alias `ACTION_AUTHORIZED`, manifest §9). `source_domain = control_loop`, `evidence_class = ACTUAL`. Registered programmatically in the `BusinessEventContractRegistry`; the event-contracts tests join the CI filter. |
| Producer | The ABA issuer, **in the issuance transaction** (the outbox enqueue joins the shared tenant transaction), so the package and its event commit or roll back together. Emission is gated by the activation control (§16): with it OFF no outbox row is written. |
| Consumer | The BO intake consumer (`consumer_name = bo.authorized_action_intake`). |
| Payload | `packageId`, `packageVersion`, `digest`, `scope{tenant,workspace,business}`, `actionType{code,schemaVersion}`, `automationLevel`, `expiresAt?`, `decisionId`, `issuedAt`. **Not** the package body, parameters, owner or boundaries. |
| Correlation | `correlation_id` carried from the package `trace`; `causation_id` = the package's causation (decision/audit event). |
| Ordering | No ordering is relied on. Supersede/revoke events (if added later) are advisory; the pull at execution time is authoritative [RULED, R-10: "both; the pull is authoritative at the moment of execution"]. |
| Delivery | At-least-once (outbox → ledger → subscription). **No exactly-once claim.** |
| Deduplication | Ledger idempotency key `aap:{packageId}:{packageVersion}`; inbox `UNIQUE(event_id, consumer_name)`; BO receipt unique on (package id, version); BO claim unique on (package id, version). Replay is delivery-only (existing replay rule requires an ABA approval reference for action-like events). |
| Failure | Provider/source unavailable ⇒ intake attempt `REFUSED(STATUS_UNAVAILABLE)` and a delivery retry; permanent failure ⇒ existing dead-letter path. A poison event never blocks others. |
| Runtime | **[MISSING]** — nothing delivers events today. A worker is required (O-1: where it runs). |

## 5. Decision 3 — receipt vs claim vs execution (state machine)

Existing vocabulary is reused; the only new facts are execution outcomes.

```
[delivery]  --intake-->  RECEIVED (receipt row, immutable)             REFUSED(code) -> intake attempt row; receipt kept if ABA vouched identity
RECEIVED    --claim--->  CLAIMED  (claim row = ABA "CONSUMED" mirror)  claim does NOT confer authority and is NOT execution
CLAIMED     --final authority/status check + mutation tx-->
                         SUCCEEDED | FAILED | REFUSED               (one terminal execution row per claim, written atomically with the mutation or its refusal)
```
- `CONSUMED` keeps its ruled meaning: BO atomically claimed the version for one execution attempt. Not mutation, success or completion.
- **`EXECUTION_STARTED` is not needed [PROPOSAL].** The mutation, the execution row, the audit row and the outbox row are one PostgreSQL transaction, so there is no durable "started but unknown" state; a crash rolls everything back. "Claimed, no execution row" is a *derived* state (recoverable, §14). A separate started row would add an update/append dance to append-only tables for no safety gain.
- Outcomes: `SUCCEEDED` (mutation committed, after-state recorded; includes a recorded `NO_CHANGE` result, §12); `REFUSED` (nothing mutated; precondition/authority/window/baseline not met — a deterministic business refusal); `FAILED` (authorization verified but the operation failed deterministically after bounded retries). Vocabulary note: BO spec §16 uses `EXECUTED`/`FAILED` for its own approvals and the manifest event is `ACTION_EXECUTED`; mapping `SUCCEEDED → ACTION_EXECUTED` is O-9.
- Terminal means terminal for this claim. Re-doing a failed/refused action is a **new authorization** (a new authorized action / package), never a second execution of the same claim (see O-3).

## 6. Decision 4 — fresh authority/status check immediately before mutation

Mandatory and not satisfiable by intake-time, claim-time or cached answers. Sequence **[PROPOSAL, "verify under lock"]**:

1. BO opens the mutation transaction; takes the per-claim advisory lock; locks the **balance row `FOR UPDATE`**.
2. **Then** BO calls `AbaPackageStatusProvider.getStatus` (in-process, separate short ABA read; ABA and BO tables are disjoint, so no lock cycle).
3. BO judges the answer **against the BO database clock inside the same transaction** (the technique intake already uses): present, about this exact id/version/digest, `verifiedAt` not in the future and no older than `executionStatusMaxAgeMs`; lifecycle `ISSUED` **or** `CONSUMED` whose `consumptionReceiptId` equals this claim's receipt (§5/O-5); not superseded, not expired, current version; authority `CURRENT`.
4. BO re-checks the execution window and package expiry on its own clock, and the runtime preconditions (§9).
5. Mutation → execution row → audit → outbox → commit.

Anything other than `CURRENT` — `REVOKED`, `UNVERIFIABLE`, stale, malformed, `null`, a rejected promise — fails closed. Lock wait therefore cannot age the answer: the answer is requested after the locks are held.

**Maximum gap [RULED, O-2].** `executionStatusMaxAgeMs = 5000 ms` for v1. The bound that matters is *answer age at judgement* (steps 2→3), because the commit follows within milliseconds. It is a dedicated parameter, separate from the intake `statusMaxAgeMs`; the code still takes it as a required argument with no hidden default, and the composition root supplies 5000.

**New contract piece [PROPOSAL, O-5]:** `validateForExecution` refuses lifecycle `CONSUMED` (correct *before* a claim). After the claim the check must accept `CONSUMED` only for this BO receipt. This needs an additive optional field `consumptionReceiptId` on `AuthoritativePackageStatus` and a sibling pure function `validateForExecutionAfterClaim` (same rules, same codes, plus the receipt match). Packages and digests are unaffected.

## 7. Decision 5 — claim / revocation race

Rule: **a claim never locks in execution authority.**

| Interleaving | Result |
|---|---|
| revoked before claim | intake refuses (`AUTHORITY_REVOKED`); receipt kept, never claimable. |
| claimed → revoked → final check | final check sees `REVOKED` ⇒ terminal `REFUSED(AUTHORITY_REVOKED)`; no mutation. Historic approval/claim untouched. |
| final check `CURRENT` → revoked → commit | the mutation was authorized when verified; commit proceeds. This is indistinguishable from "revoked just after commit"; the evidence records `verifiedAt`, so the exposure is provable and bounded by `executionStatusMaxAgeMs` plus commit time. Closing it fully would need a lock shared between ABA revocation and BO mutation across owners — rejected (breaks the ownership boundary and the shared-transaction guard). **Accepted residual race, to be stated in the owner-facing risk list.** |
| revoked after commit | cannot recall execution. Business reversal is a separate authorized action (§13). |

Authority revocation is the stop mechanism. An explicit *package-level* stop after claim (R-5: "revoke-after-consume is a BO stop instruction") is not required for P0-6 v1 because approver-authority revocation already blocks the final check; modelling a separate stop instruction would need a new ABA table (O-6).

## 8. Decision 6 — inventory execution adapter

`InventoryReorderPolicyExecutionAdapter` in BO runtime. It consumes **only the receipt's sealed document** (BO's immutable copy, digest-verified at intake and again before use), never a request body, recommendation, approval text, browser payload or re-run evaluator input.

- **Inputs used:** `action.target` (`inventory_item` uuid), `action.parameters` (`reorderPoint`, `reorderQuantity`), `action.executionWindow`, `action.preconditions`, `action.rollback`, `action.monitoring`, `accountableOwner`, `validity`, `lineage` (modification, evaluation references, Simulation `NOT_APPLICABLE`).
- **Parameter validation:** both numbers finite, ≥ 0, representable at `numeric(18,4)` — **no rounding or coercion** (a value with more than four decimals is refused, matching the no-rounding stance of the cost rules).
- **Target resolution:** exactly one balance row for the item in the BO scope; none ⇒ `REFUSED(NO_BALANCE)`; several ⇒ `REFUSED(TARGET_AMBIGUOUS)`; no balance is ever created, no warehouse guessed.
- **Writer [PROPOSAL]:** add one command type (for example `update_inventory_reorder_policy`) to the existing `OperationalCommandExecutor` — the established single BO operational writer, which already runs inside a caller-owned transaction client with `FOR UPDATE` and `version` bumps. The adapter orchestrates and owns the transaction; the executor performs the SQL. **No second writer is created** (the alternative — a standalone writer class — is rejected).
- **No parameter reconstruction.** An architecture test pins that the executed values equal `receipt.package.action.parameters`, and that neither the adapter nor the executor imports a recommendation/approval/evaluator module.
- **Capability:** registered in `PRODUCTION_BO_CAPABILITIES` only by the final activation block (§16).

## 9. Decision 9 — runtime boundary enforcement (listed before the transaction because it shapes it)

Package issuance proves what was authorized then; it does not prove anything about the world at execution. Per boundary:

| Boundary | Before mutation | During mutation | Recorded afterwards |
|---|---|---|---|
| Execution window | BO DB clock: `startsAt ≤ now < endsAt`; the claim trigger already refuses a not-yet-open window — re-checked here (the window may close between claim and execution) | — | window and times in the evidence |
| Expiry / validity | package `expiresAt` and ABA lifecycle `EXPIRED`, both on current clocks | — | verified-at facts |
| Preconditions (`{code, operator, operand}`) | BO evaluates each under the balance lock with a **BO-defined vocabulary**: `stock_available` (against `quantity_available`) is already used in fixtures; a **baseline precondition** is required for this action (below). An **unknown code or unsupported operator ⇒ `REFUSED(UNSUPPORTED_PRECONDITION)`** — silently ignoring a precondition is never safe | the same row lock keeps them true until commit | each precondition and its observed value |
| Baseline (compare-and-set) | see §12 | `UPDATE ... WHERE` equals the baseline | before/after state |
| Budget | not a runtime spend for a policy-field update; **record-only [PROPOSAL, O-8]** — amount/currency copied into the evidence. The approval-time order-value cap was already enforced by the B2 COST evaluation (K3/K4). BO does not recompute cost at execution | — | recorded |
| Rollback | instructions are free text; BO stores them with the evidence and **captures the machine-usable before-state** | — | before-state + instructions |
| Monitoring | not a gate; metrics are recorded and handed to OM in the evidence handoff | — | recorded |
| Simulation `NOT_APPLICABLE` | no runtime effect; lineage only | — | recorded |
| Current authority/status | final pull (§6) | — | recorded |

## 10. Decision 7 — mutation transaction

One PostgreSQL transaction on the BO side:

1. `SET LOCAL` scope GUCs (existing tenant transaction helper); take `pg_advisory_xact_lock` keyed on the claim id.
2. Read the claim and receipt; refuse if an execution row for this claim already exists (replay returns it, §11).
3. Lock the target balance row `FOR UPDATE` (pessimistic; `READ COMMITTED` is sufficient because the row lock serializes writers of this row).
4. Fresh status/authority pull and judgement (§6); window; preconditions; baseline compare-and-set (§12).
5. `UPDATE inventory_balances SET reorder_point, reorder_quantity, version = version + 1 WHERE id = $1 AND reorder_point = $baselineRp AND reorder_quantity = $baselineRq` — the `WHERE` guard plus `rowCount = 1` is the second line of defence behind the lock.
6. Insert the **execution row** (the evidence record of §11A), the audit event row, and the outbox row (`operations.action.executed@1`), all on the same client.
7. Commit.

**Rolls back together:** the balance update, the execution row, the audit row, the outbox row. **Not atomic with** (and not claimed to be): the ABA `CONSUMED` mirror (separate port, own transaction), event delivery (outbox gives at-least-once *after* commit), and OM consumption. No distributed atomicity is promised.

Refusals before step 5 write only an **attempt row** (transient) or a **terminal `REFUSED` execution row** (deterministic) in their own short transaction, never a mutation.

## 11. Decision 8 — idempotency and exactly-once semantics

No global exactly-once is claimed. Practical guarantees per stage:

| Stage | Mechanism | Guarantee |
|---|---|---|
| Event delivery | outbox → ledger, idempotency key `aap:{package}:{version}`, inbox dedupe | at-least-once, effectively-once processing |
| BO intake | unique receipt (package id, version); digest collision refused | exactly one receipt per version |
| Claim | unique claim (package id, version) + advisory lock | exactly one claim per version (existing, tested 3×8 concurrent) |
| Mutation | **unique `claim_id` on the execution table** + per-claim advisory lock + balance row lock + baseline compare-and-set | a replayed package cannot change the policy twice: the second transaction cannot insert a second execution row, and could not match the baseline anyway |
| Evidence emission | the execution row *is* the evidence (BO truth); the outbox row is written in the same transaction, keyed `aap-exec:{execution_id}` | published exactly when the execution committed; delivery at-least-once; consumers dedupe on the event id |

A duplicate invocation after the outcome exists returns the stored outcome (`REPLAYED`) without touching the balance or emitting a second event.

## 11A. Decisions 10 and 11 — `ExecutionEvidence` contract, ownership and OM handoff

**No contract exists** (§1), so nothing is renamed or reused; this proposes it. **[PROPOSAL]** `execution-evidence/1`, a shared contract in `handoff-contracts` (types + a pure validator, like `aap/1`), **owned and written by Business Operations**.

| Group | Fields |
|---|---|
| Identity | `executionId`, `contractVersion`, `packageId`, `packageVersion`, `packageDigest`, `claimId`, `receiptId`, scope (`tenantId`, `workspaceId`, `businessId`), `actionType{code,schemaVersion}`, `target{kind,id}` |
| Timing (BO database clock, ms UTC) | `claimedAt` (from the claim), `executionStartedAt` (mutation transaction start), `executionCompletedAt` (commit-time stamp), `evidenceRecordedAt` (execution row insert) |
| Authority | `authorityVerdict` (`CURRENT` or the refusing state), `statusVerifiedAt` (ABA time), `authorityVerifiedAt`, `statusAnswerDigest` (digest of the canonical answer BO judged — the provider reference), `providerComponent` + `providerVersion` |
| Mutation | `before` (`reorderPoint`, `reorderQuantity`, `balanceId`, `balanceVersion`), `requested` (the package's final parameters), `after` (same shape, or `null` when nothing changed), `mutationResult` (`APPLIED`, `NO_CHANGE`, `NOT_APPLIED`) |
| Preconditions / boundaries | each evaluated precondition with its observed value; window used; budget, rollback instructions and monitoring metrics copied from the package (record-only, §9) |
| Outcome | `outcome` (`SUCCEEDED`, `FAILED`, `REFUSED`), stable `reasonCode`, non-sensitive `detail` (no stack traces, no secrets) |
| Lineage | `correlationId`, `causationId` (= the claim), `executor{type:'system', id}`, authorization lineage (decision id/version, evidence references from the package) |
| Integrity | **sealed**: canonical JSON (the existing `canonicalize`) + SHA-256 digest stored with the row; tamper evidence only, never authorization (the same stance as `aap/1`) |

**Ownership.** BO creates the execution fact (`authorized_action_executions` is the source of truth; the evidence document is its sealed projection). The ledger **transports** it (`operations.action.executed@1`, alias `ACTION_EXECUTED`, `evidence_class = ACTUAL`, a reference + digest, not a copy of authority). OM **consumes verified evidence**. ABA never becomes the execution-result source of truth: it records only the `CONSUMED` lifecycle mirror (a claim fact), and ABA never reads the execution table. OM may not infer success from issuance, authorization, a claim or the legacy interim outcome route.

**OM handoff.** OM obtains the evidence document through a BO-owned reader port (the mirror of the ABA ports), verifies contract + digest + that the event reference matches, and only then writes `outcome_monitoring.action_execution_observations` (its `detail` carries the evidence reference and digest, not a re-statement of the outcome). An observation made without verified evidence stays manual/unverified and cannot become verified learning evidence [RULED, Block 1 §9]. Whether the OM intake requires a new OM migration is decided in P0-6d (none is expected: `detail jsonb` already exists).

---

## 12. Decision 12 — action result and inventory state

- **Authoritative target:** `business_operations.inventory_balances` row for the package's `inventory_item` in the BO scope (exactly one).
- **Current values:** `reorder_point`, `reorder_quantity` (numeric(18,4)); concurrency column `version`; `updated_at` (trigger).
- **Locking:** pessimistic row lock (`FOR UPDATE`) inside the mutation transaction.
- **Baseline problem (new finding).** The package carries `proposedParameters` and, for modified approvals, `changes[].before` — but there is **no authoritative "state at authorization time" for plain approvals**, and the evaluator baseline lives in BO evaluation records. Writing blindly would overwrite a legitimate newer state. Options: (A) require BO evaluation evidence (and so a baseline snapshot) for every approval of this action; (B) require baseline preconditions (`current_reorder_point eq`, `current_reorder_quantity eq`) in the governed boundaries; (C) execute **only packages whose baseline BO can prove**. **[PROPOSAL: C for v1]** — for modified approvals BO reads the evaluation records referenced in `lineage.modificationEvaluation` (BO-owned, immutable) and takes `inputs.facts.balances[0]` (baseline reorder values and balance id) as the compare-and-set baseline; a plain approval with no provable baseline ⇒ `REFUSED(NO_BASELINE_EVIDENCE)`. This is a real product limitation and is **O-4**.
- **Baseline changed since evaluation** (manual change or another package) ⇒ terminal `REFUSED(BASELINE_CHANGED)`; the newer state is never overwritten. The authorization is stale; a new evaluation and authorization are required.
- **No-op** (current equals the final values): no `UPDATE`, no `version` bump; outcome `SUCCEEDED` with mutation result `NO_CHANGE`; the claim is still consumed [PROPOSAL, O-12].
- **Concurrent administrator/manual mutation:** today no code path updates the reorder fields after creation, so concurrent writers do not exist yet; the row lock plus compare-and-set covers the future ones. A database guard (§20 M3) would make "the adapter is the only writer" a database fact rather than a convention.

## 13. Decision 13 — rollback semantics

Three different things, never conflated:
1. **Database transaction rollback** — automatic, covers everything in §10. A failed mutation leaves no partial effect.
2. **Business rollback after a successful commit** — *not automatic*. The package's `rollback` field is **free-text instructions**, not an executable undo. BO records the exact **before-state** in the evidence so a reversal can be authored.
3. **Reversal** — a **separate authorized action** (a new package restoring the before-state, through the full authoring chain), or a manual operational change outside P0-6. No auto-compensation in P0-6; the legacy compensation block (ABA-20) is not wired. Whether OM findings may ever *propose* a reversal is a later learning-loop question (O-13).

## 14. Decision 14 — failure and retry

| Situation | Behaviour |
|---|---|
| status provider unavailable / error | transient: attempt row `REFUSED(STATUS_UNAVAILABLE)`, no terminal outcome, retry within window/expiry |
| authority `UNVERIFIABLE` | transient like the above; never treated as `CURRENT` |
| authority `REVOKED`, package `REVOKED`/`SUPERSEDED`/`EXPIRED` | terminal `REFUSED` with the specific code |
| database deadlock / serialization / connection loss | whole transaction rolled back; retried; bounded by attempts (O-3) |
| baseline changed | terminal `REFUSED(BASELINE_CHANGED)` |
| execution window closed / expired | terminal `REFUSED(EXPIRED or WINDOW_CLOSED)`, recorded by the recovery runner if nobody retried |
| package already claimed | intake returns `REPLAYED`; execution row unique prevents a second outcome |
| retry after a failed mutation | the same claim may resume only while no terminal row exists; after a terminal `FAILED`/`REFUSED` the claim is spent and a **new authorization** is needed |
| retry after an *uncertain* outcome (connection lost at commit) | safe: read the execution row by claim id — present means committed (return it), absent means rolled back (resume); the unique key makes a blind retry harmless |
| duplicate `ACTION_AUTHORIZED` delivery | inbox + receipt/claim uniqueness; no second claim |
| crash after the mutation commit but before the event is delivered | the outbox row committed with the mutation; delivery resumes (at-least-once) |
| crash after claim, before execution | derived state "claimed, no outcome"; a recovery runner re-drives claims older than a threshold (the threshold is O-3) |
| crash between claim and the ABA `CONSUMED` mirror | BO's claim is canonical [RULED, Block 3e]; the mirror is retried idempotently; the final check accepts `ISSUED` only when BO itself holds the claim for the same digest |

Where durability is required: the execution row and the outbox row (same transaction as the mutation); the attempt log for transient refusals; the dead-letter table for undeliverable events.

## 15. Decision 15 — audit

Append-only, written on the same client as the fact it describes, through a BO audit wrapper onto `audit.audit_events` (no second store). Proposed actions:
`bo.authorized_action.received`, `.refused`, `.claimed`, `.preverified` (verdict + `verifiedAt` + answer digest), `.execution_refused`, `.executed`, `.execution_failed`, `.evidence_published`; the ABA side keeps `package.issued` and records the mirror in its own lifecycle fact. Each row carries actor (system executor identity), scope, package id/version/digest, correlation id, and outcome/refusal code; no secrets or payload bodies.

## 16. Decision 16 — feature flag / activation

P0-6 stays OFF. Safety must not depend on an environment variable being *absent*. **[PROPOSAL] three independent keys, all required:**
1. **Build-time registry** — `PRODUCTION_SUPPORTED_ACTION_TYPES` stays empty until the final block; one reviewed one-line change adds `inventory_reorder_policy_update@1`. A guard asserts the entry exists only together with the E2E suite.
2. **Runtime governed activation record** — an append-only, version-chained BO table (`execution_capability_activations`: scope, action type + version, `ENABLED`/`DISABLED`, actor, permission, reason, time). **No row ⇒ OFF.** Staging/preview activation is a row in a staging scope, separable from production.
3. **Global kill switch** — a process-level setting that defaults OFF and can only *remove* capability (it can never enable by itself).
`supports(code, version)` = registry ∧ activation ENABLED for the scope ∧ kill switch not engaged. The producer (§4) and consumer are gated by the same control; with it OFF no event is emitted and no claim is made, so packages stay `ISSUED` and can execute later, after activation, until they expire. No route and no event handler can reach execution outside this gate. Activation requires all P0-6 tests green (CI gate) and an explicit owner action (permission/scope: O-11).

## 17. Decision 17 — `approval_decisions.updated_at` hard freeze

**Survey.** Status of a decided row is immutable by trigger; `updated_at` is not (a non-status `UPDATE` re-stamps it with `now()` — forward only). No production code updates a decided row (only status updates exist).
- **A (current fail-closed behaviour):** sufficient for *execution* authority, because the sealed package copies `modifiedAt` into its lineage and execution re-checks the package, not the live decision row; drift can only make a later *capture* chronology stricter.
- **B (small migration):** extend `enforce_decision_immutability` so any `UPDATE` of a decided row is rejected (not only status changes).
**Recommendation: B — RULED (O-14), P0-6.0**, because the timestamp is authoring-chronology authority and the guard is cheap, but it is not a P0-6 execution blocker; it can ship as its own tiny block (P0-6.0). No historical-data impact (affects future updates only); an existing B2c test that demonstrates drift must be updated. **Not created here.**

## 18. Accepted limitations carried forward (not "fixed" by P0-6)
BO facts and declared currency are read separately, not under one cross-domain PostgreSQL snapshot; `approval_decision_modifications` remains unused; unit-of-measure explicit-vs-default is unresolved; no FX; ISO 4217 membership deferred; the accepted residual race in §7.

## 19. Data-capture blocks A / D / E

| Block | Classification | Evidence |
|---|---|---|
| **A** purchase receipt write path | **INDEPENDENT** | It adds cost/receipt *data* that improves the COST evidence (K1). Execution safety depends on the sealed package, the final authority check and the compare-and-set — none read receipts. |
| **D** PO/receipt/item linkage | **INDEPENDENT** | Same: enriches evaluation context; nothing in the execution path reads PO lines. |
| **E** `reorder_policy_state` + a BO configure command | **INDEPENDENT for safety; coupled by design** | v1.0.0 sets `FIRST_CONFIGURATION_OPTION = NO`, so the evaluator already makes a zero baseline INDETERMINATE: any executable package has a non-zero baseline, and compare-and-set on exact values does not need an UNSET/CONFIGURED flag. But the data-capture record planned that "the future authorized P0-6 execution would use that same command" and set `CONFIGURED`. Sequencing is **ruled (O-10): E lands before P0-6c.** Not required to be safe. |
(Already done: B, positive cost, 0187; C, currency, 0183.) I hold ~85 % confidence in the E classification because it rests on the evaluator's zero-baseline rule staying as ruled.

## 20. Migration needs (none allocated; numbers are discovered at implementation time per the allocation policy)

| # | Schema | Purpose | Shape | Historical data | RLS / append-only | Depends on |
|---|---|---|---|---|---|---|
| M0 | approved_business_action | freeze decided decisions (§17 B) | replace `enforce_decision_immutability` (and the version guard) | none | existing | none |
| M1 | business_operations | `authorized_action_executions` (one terminal row per claim, `UNIQUE(claim_id)`; FK to the claim/receipt scope key; outcome, codes, before/requested/after state, authority/status facts, timing, evidence document + digest, correlation) and `authorized_action_execution_attempts` (transient refusals) | tables, CHECKs, DB-clock stamping triggers (the 0180 pattern), indexes | none (new tables) | tenant+workspace RLS forced; `forbid_mutation` for UPDATE/DELETE/TRUNCATE | claims table (0180) |
| M2 | business_operations | `execution_capability_activations` (§16) | version-chained append-only table | none | RLS forced, append-only | none |
| M3 (approved, O-11) | business_operations | `CHECK (reorder_point >= 0 AND reorder_quantity >= 0) NOT VALID` and a trigger that rejects reorder-field changes unless the adapter's transaction-local marker is set | trigger + check | `NOT VALID`, no backfill | existing | M1 |
| M4 (ruled O-10: before P0-6c) | business_operations | Block E `reorder_policy_state` | column + CHECK | none; **no backfill without a ruling** | existing | E decision |
Expected total: **5** (M0, M4 (Block E), M1, M3, M2), landing in the order P0-6.0, Block E, P0-6c (M1 + M3), P0-6e (M2). ABA needs **no** migration for the consumption mirror (the existing `CONSUMED` + `consumption_receipt_id` fact suffices); the event contract and registry entries are code, not schema. The migration count is "several"; each is a separately reviewed block.

## 21. Implementation split (smallest safe sequence; each its own owner authorization)

| Block | Scope | Migration | Production behaviour change |
|---|---|---|---|
| **P0-6.0** | `updated_at` freeze (M0) + test update | M0 | none |
| **P0-6a** | ABA side only: `AbaPackageStatusProvider`, `AuthorizedActionPackageSource`, `PackageConsumptionRecorder`, shared authority-currentness function (issuer refactor), additive `consumptionReceiptId` + `validateForExecutionAfterClaim` in the contract | none | none (unwired) |
| **P0-6b** | `control_loop.action.authorized@1` contract + registry + gated issuer emission; BO consumer + dispatcher worker (host per O-1); intake wired to the real ports. Capability still empty ⇒ received, refused `ACTION_TYPE_UNSUPPORTED_BY_EXECUTOR`, **never claimed** | none | emission gated OFF |
| **Block E** (data-capture; ruled O-10: lands **before** P0-6c, not folded into it) | `reorder_policy_state` and the canonical BO configuration path per the existing Block E specification | M4 | none |
| **P0-6c** | M1 + M3 (approved, O-11); adapter + executor command + transaction + execution/attempt writers; recovery runner; tests inject a test capability | M1(,M3) | none (capability absent) |
| **P0-6d** | `ExecutionEvidence` contract (handoff-contracts, sealed/digest), `operations.action.executed@1`, BO→OM handoff + OM intake adapter verifying evidence and writing `action_execution_observations`; ABA mirror at claim | none | none |
| **P0-6e** | M2 activation table + the three-key gate + kill switch; full E2E (issue → event → intake → claim → final check → mutate → evidence → OM) on a staging profile; the one-line registry change; activation runbook | M2 | **capability exists but OFF** |
The ExecutionEvidence *contract* can be pulled forward into P0-6c if the owner prefers one schema review. **Production activation is never part of a block**; it is an explicit owner action.

## 22. Test plan (defined before implementation)

Contract/unit: valid package accepted; revoked, expired, superseded, wrong-digest, wrong-business refused; stale/future/malformed/`null` status refused; `UNVERIFIABLE` refused; claim + `consumptionReceiptId` match required after claim; precondition vocabulary (unknown code/operator refused); parameters with >4 decimals refused; window boundaries on the BO clock.
Integration (live PostgreSQL, least-privilege role, RLS): duplicate delivery safe; duplicate claim safe; **duplicate mutation impossible** (N parallel executors, one effect, one execution row, one event); concurrent manual change ⇒ `REFUSED(BASELINE_CHANGED)` and the newer value survives; parameters are the sole execution parameters (packages with divergent recommendation/approval/evaluator data); **current authority checked immediately before mutation** (provider spy asserts call order *after* the row lock and answer age judged on the BO clock); **revocation after claim blocks mutation**; revocation between check and commit is the documented residual (asserted, with `verifiedAt` recorded); execution window enforced; operational failure recorded; successful mutation exact (values, `version + 1`); before/after evidence exact; no-op recorded as `NO_CHANGE`; crash/retry (kill after claim; after commit; connection loss at commit) with no duplicate effect and no duplicate evidence; transient provider failure retried; capability off prevents execution **and** claim; production registry empty until activation; activation record absent ⇒ OFF; kill switch removes capability; staging scope activation does not enable production.
E2E (P0-6e): the full chain with real components and no fakes for the ports, ending in an OM observation that verifies the evidence digest.
Architecture: ADI executes nothing; ABA writes no inventory; BO reads no ABA tables; BO uses only the ports; the adapter is the only reorder-field writer (and the guard test if M3); OM never infers success from a package/claim; no second audit store.

## 23. Mutation proof set planned (semantic mutants; no syntax/type-invalid kills)
skip the final authority check · treat `REVOKED` as `CURRENT` · treat `UNVERIFIABLE` as `CURRENT` · ignore expiry · ignore the execution window · reconstruct parameters from the recommendation/approval · bypass claim uniqueness · execute the same package twice · omit the concurrency guard (row lock / compare-and-set) · emit success evidence without a mutation · mutate without evidence durability (outside the transaction) · mark the claim as execution success · enable the capability by default · bypass the feature flag / activation record / kill switch · ABA writes inventory · OM infers execution from package issuance · answer age judged on the caller clock · verification performed before the row lock · unknown precondition ignored · baseline check removed · no-op treated as an update · second execution row per claim · outbox row written outside the transaction.

## 24. Architecture risks
1. **No event runtime exists.** The largest unplanned cost is the dispatcher/worker and its hosting (O-1); `ACTION_AUTHORIZED` cannot deliver anything without it.
2. **Verify-under-lock** holds a BO row lock during an in-process ABA read: needs a second pooled connection per execution (pool-exhaustion tests) — no lock cycle (disjoint tables), but it must be load-tested.
3. **Accepted residual race** (§7): revoke between final check and commit.
4. **Plain approvals** cannot prove a baseline (O-4): a product limitation of v1.
5. **Isolation guards** (`boIsolation`, workflow shared-transaction guard, issuer-only sealer guard) must be *extended*, never loosened; the status provider lives on the ABA side precisely to keep BO free of ABA imports.
6. **Legacy ABA execution blocks** (17/19/20/21) look like a ready-made engine; wiring them would move execution/evidence ownership into ABA. They must stay unimported.
7. **Contract amendment** (`consumptionReceiptId`, `validateForExecutionAfterClaim`) touches a locked, sealed-package-adjacent contract; additive and digest-neutral, but it needs explicit approval.
8. **Reorder fields have no guard today**; until M3 (or equivalent) the "single writer" is a convention.
9. **Stale builds:** apps consume other packages' `dist`; CI builds first, local runs must too.

## 25. Owner rulings (recorded; all decisions O-1..O-15 are RULED)

Source: the owner's high-autonomy programme completion mandate (12 October 2026). The plan above is unchanged except where noted.

| # | Ruling |
|---|---|
| O-1 | The worker runs as a **separate process under deployment/infrastructure**. The API stays request-only (no polling loop in the API process). |
| O-2 | `executionStatusMaxAgeMs = 5000 ms` for v1. |
| O-3 | Transient execution retries: **maximum 3 attempts, backoff 1 s / 5 s / 15 s**; claimed-without-outcome recovery threshold **60 s**. A terminal `FAILED` or deterministic `REFUSED` is never re-driven; a **new authorization** is required after a terminal outcome. |
| O-4 | Plain approvals without an authoritative baseline are **refused in v1** (`REFUSED(NO_BASELINE_EVIDENCE)`); modified approvals use their immutable BO evaluation evidence as the baseline; a changed live state is `REFUSED(BASELINE_CHANGED)`. |
| O-5 | Approved: the additive `consumptionReceiptId` on the status contract, `validateForExecutionAfterClaim`, and the ABA `CONSUMED` mirror at BO claim. **The BO claim remains the canonical consumption truth.** |
| O-6 | No separate package-level stop after claim in v1 (approver-authority revocation is the stop). |
| O-7 | Disabling the applicable Level 2 policy after issuance **blocks execution** (fail closed). |
| O-8 | Budget is **record-only** for `inventory_reorder_policy_update@1`. |
| O-9 | Names approved: `control_loop.action.authorized@1` (alias `ACTION_AUTHORIZED`); outcomes `SUCCEEDED` / `FAILED` / `REFUSED`; `operations.action.executed@1` (alias `ACTION_EXECUTED`). |
| O-10 | Data-capture **Block E lands before P0-6c** and is not folded into it. |
| O-11 | Activation is **per business**, reuses the appropriate existing admin permission; the global kill switch is controlled by platform administration; the **M3 reorder-field database write guard is approved**. |
| O-12 | A no-op **consumes the claim** and records `SUCCEEDED / NO_CHANGE`: no `UPDATE`, no `version` bump. |
| O-13 | OM reversal proposals are **deferred**. |
| O-14 | The hard freeze of finalized `approval_decisions` (any `UPDATE` of a decided row rejected) is approved as **P0-6.0**. |
| O-15 | The live Supabase head is **re-checked before any live/migration deployment decision**; 0169 is never assumed. |

Programme gates that remain with the owner (unchanged by these rulings): merging any PR, production activation, any live Supabase migration, any destructive migration/backfill, new business-policy thresholds without an approved value.

## 26. Not done / not changed
No code, migration, route, event contract, capability or flag was created or changed. The production capability registry is empty and unchanged. P0-6 is not started and is not enabled. Live Supabase was not touched.
