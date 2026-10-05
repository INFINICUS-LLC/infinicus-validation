# BUILD-33 — Business Event Architecture

Status: FROZEN — approved for BUILD-33 implementation on 2026-10-05.
Prepared: 2026-10-04.
Dependency: BUILD-32 completed and validated.
Inspected baseline: `build-32-business-operations-runtime` at `0e6cb2c0435481e5b1446cb86023ffc1102e191d`.

## 1. Objective and authority

Establish the canonical cross-domain business Event Ledger under DATA, with governed event contracts, durable ingestion from the existing transactional outbox, tenant-scoped reads, and controlled delivery/replay. Preserve the existing domain runtimes, handoff contracts, and event transport.

The BUILD-32 frozen specification reserves cross-domain Business Event Architecture for BUILD-33. Its domain ownership map places the Event Ledger in DATA. That reservation establishes the architectural destination, not an approved implementation scope. The user approved this specification on 2026-10-05. Its decisions are authoritative for BUILD-33.

BUILD-32 is completed and merged. BUILD-33 implementation is authorized on a separate branch; deployment, changes to main, and automatic historical replay remain excluded.

## 2. Locked ownership

The eight business domains remain EXPERIENCE, BUSINESS ADMINISTRATION, COMMERCE, OPERATIONS, FINANCE, DATA, INTELLIGENCE, and CONTROL LOOP. Transport, authentication, tenancy, audit, and observability remain cross-cutting infrastructure, not a ninth domain.

| Concern | Owner and boundary |
|---|---|
| Business fact and its meaning | Originating domain; the ledger cannot invent or reinterpret it |
| Canonical cross-domain Event Ledger | DATA |
| Outbox, delivery, retries, consumer inbox | Existing cross-cutting event infrastructure |
| Inventory, procurement, suppliers, workforce, assets | OPERATIONS |
| POS, orders, payments, customers, refunds | COMMERCE; existing BO compatibility names do not change ownership |
| Accounting truth and financial balances | FINANCE; events do not create accounting entries by themselves |
| Analytics and decisions | INTELLIGENCE, through existing governed interfaces |
| Approvals, actions, outcomes, learning | CONTROL LOOP; replay must not bypass approvals |

The ledger is a durable record of accepted events, not a replacement operational database, accounting ledger, audit trail, or event-sourced reconstruction of every domain.

## 3. Observed baseline and mandatory reconciliation

The following are repository observations at the inspected commit, not assertions about a future implementation branch:

| Existing surface | Evidence | Proposed treatment |
|---|---|---|
| Transactional outbox, inbox, dead letters, subscriptions, attempts | `infinicus-platform/infrastructure/database/migrations/0007_create_events_schema.sql` | KEEP/EXTEND; no parallel event bus |
| Original outbox/inbox tenant policies | Migration `0011_create_rls_policies.sql` | ADAPT where current effective policies lack required scope |
| `PlatformEvent` | `infinicus-platform/packages/shared-types/src/index.ts` | KEEP public compatibility; versioned adapter for canonical envelope |
| Event names and legacy layer identifiers | `infinicus-platform/packages/event-contracts/src/index.ts` | EXTEND with runtime registry; retain exports and existing names |
| DA transactional emission | `infinicus-platform/packages/database/src/repositories/da/outbox.ts` | KEEP typed SQL wrappers and transaction ownership |
| BO event wrappers | Migration `0036_create_bo_triggers_events.sql` | KEEP names, payload semantics, and existing callers |
| Operational compatibility facts | `BusinessEventRepository` and BUILD-32 `OperationalEventService` | KEEP; not the universal ledger |
| DA → BO and BO → BI | Existing handoff-contracts and runtime services | KEEP governed package delivery and acknowledgements |
| Backlog monitoring | `infinicus-platform/packages/database/src/repositories/observability/outboxMonitor.ts` | ADAPT carefully; do not represent RLS-filtered zero as global health |
| Historical event-backbone phase prompts | `docs/implementation-queue/04-event-backbone-phase-1.md` and subsequent event phases | Reference designs only; reconcile against actual code |

Observed gaps requiring explicit design resolution:

- `PlatformEvent` lacks workspace identity; it requires business and publication time even though original outbox columns permit null values.
- The event-type union permits arbitrary strings; compile-time typing alone is not runtime validation.
- Original inbox uniqueness is `(event_id, consumer_name)`, without explicit workspace/business columns.
- Original dead letters have no explicit tenant/workspace columns. Original subscriptions are global by subscriber name.
- Original attempt uniqueness is `(outbox_event_id, attempt_number)`, insufficient by itself to track independent subscriber outcomes.
- An outbox row has mutable delivery status. It cannot be treated as an immutable canonical ledger merely by renaming it.

Inspect all later migrations, exports, workers, grants, callers, and tests before concluding these gaps remain. Do not infer runtime completion from historical prompts or tables alone.

Before code, produce `docs/architecture/BUILD-33-EVENT-RECONCILIATION.md` with KEEP, EXTEND, ADAPT, DEPRECATE-LATER, or NOT-IN-BUILD-33 for every affected component. Include source paths, effective constraints/RLS, event-name mappings, emitter call sites, transaction boundaries, and evidence for each proposed schema addition. Preserve frozen historical specifications.

## 4. Bounded implementation scope

Deliver one coherent PostgreSQL-backed path:

1. A versioned runtime contract registry and deterministic legacy adapters.
2. Immutable ledger acceptance from existing committed outbox events.
3. Durable consumer delivery state, bounded retries, and controlled dead-letter replay using existing infrastructure where possible.
4. Tenant/workspace/business-scoped ledger read endpoints and restricted replay controls.
5. Live integration of the four existing event types below and compatibility tests for existing handoffs.
6. Migration, operational runbook, recovery tests, and completion evidence.

Initial supported event set:

| Existing type | Domain | Required source |
|---|---|---|
| `da.data.published` | DATA | Governed DA publication outbox wrapper |
| `bo.inventory.movement_recorded` | OPERATIONS | Committed inventory movement and existing outbox emission |
| `bo.purchase_order.approved` | OPERATIONS | Guarded procurement approval and its existing outbox emission |
| `bo.data.published` | OPERATIONS | Governed BO publication outbox wrapper |

Verify each spelling, version, payload shape, and live emitter during reconciliation. Missing wiring for a listed event is an explicit in-scope gap; it must preserve the owning service's validation and transaction. Do not add synonyms. Other existing events remain untouched and must not be claimed or dead-lettered by this build's worker. Do not enable all legacy events through a wildcard subscription.

The ledger consumer is the required production consumer. Prove independent fan-out with two registered test consumers. Production automation of DA → BO or BO → BI delivery is deferred: recording a publication event must not call the existing business intake again or acknowledge a package. Event-delivery receipt and business-handoff acknowledgement are distinct states.

## 5. Canonical contract and registry

Extend `@infinicus/event-contracts` and existing shared types compatibly. Do not silently change the legacy `PlatformEvent` shape. A separately named/versioned canonical contract must distinguish envelope version from event payload version.

For the initial business-scoped event set, require:

- Stable event ID and original outbox ID; existing event identity survives delivery and replay.
- Exact registered event type/version, envelope version, producer identity, and owning business domain.
- Tenant, workspace, and business IDs validated together against canonical records.
- Aggregate type/ID; correlation ID; causation ID when supplied, with an explicit absent value for a genuine root event.
- Occurrence time from the producer; server acceptance time; publication time nullable until it actually occurs.
- Validated bounded payload or typed reference, provenance references, and applicable lineage/quality/consent metadata preserved without fabricating missing evidence.
- Deterministic content digest and adapter version for duplicate/conflict detection.

Each registry entry declares schema, allowed producer, ownership, allowed consumer, adapter/version, payload limits, and sensitive-field policy. Default maximum encoded envelope size is 256 KiB; oversized payloads use an authorized reference, never silent truncation.

Registry membership, ownership, and schema validation are server-side checks. A caller-supplied event name or domain is not authority. Unknown versions of a supported type fail closed and remain observable. Tenant-level/platform events without a business require a future explicit scope contract; never insert nil IDs to make them fit.

Legacy adapters preserve original payload and identifiers, resolve absent business/workspace identity only through trusted scoped database lookups, and reject unresolved or ambiguous identity. They must not mutate the source event or accept executable content, secrets, arbitrary SQL, or remote URLs as executable destinations.

## 6. Ledger semantics and persistence

Reuse a proven equivalent ledger if reconciliation discovers one; otherwise add a dedicated immutable relation to the existing database package/schema architecture. Do not create a second authoritative operational fact store.

- Accept only committed source events. Producer mutation and outbox write remain one transaction.
- Ledger acceptance, consumer inbox success, and durable delivery receipt commit atomically in one database transaction.
- Same source identity and same canonical digest return the existing acceptance. The same identity with different content is a conflict, recorded without overwriting accepted data.
- Digests exclude delivery attempt counters and acceptance time; canonicalization is versioned and tested. A retry must not rederive historical business facts from subsequently changed mutable rows.
- Once accepted, event identity, scope, payload, provenance, and occurrence time are immutable to the application role. Corrections are linked new events, never edits to history.
- Delivery status belongs in separate mutable state. Deleting/archiving transport rows must not cascade-delete ledger records or their evidence.
- No global business ordering or exactly-once network-delivery claim. Use at-least-once delivery and idempotent database effects. Aggregate ordering is only promised where a verified source sequence exists; timestamps alone are not sequence numbers.
- Read pagination uses a stable server-assigned acceptance key with a tie-breaker and an upper watermark. Late source events become new acceptances; clients can resume without losing them.

No automated purge or bulk historical import in this build. Establish an explicit activation checkpoint per scope; pre-checkpoint backlog remains preserved for a separately reviewed import. Enabling a consumer must not silently process all historical records. Document disk-growth monitoring and the future retention decision; do not invent a universal retention period or retain unnecessary personal data.

## 7. Delivery, failure, and replay

Reuse existing dispatch code if present. Otherwise add the smallest internal PostgreSQL worker consistent with existing application/deployment conventions; no external broker or new transport framework.

- Claim bounded eligible work atomically, using row locking or a proven equivalent. Proposed defaults: batches of 100, concurrency 4, 60-second renewable leases.
- Record ownership token, lease expiry, and per-consumer outcome durably. Stale workers cannot acknowledge work after reassignment.
- Snapshot eligible consumers when accepting a dispatch item. Later registry changes must not retroactively add consumers without an explicit backfill/replay plan.
- One failed consumer does not erase another consumer's receipt or cause repeated business effects. Preserve compatible outbox status meanings; document aggregate status calculation.
- Use five total attempts by default, exponential delay starting at 30 seconds, capped at 15 minutes with bounded jitter. Retry transient failures; validation, scope, and content conflicts require correction or quarantine.
- Persist terminal failure, sanitized reason, original identity, consumer, scope, and attempt history. Reuse/extend existing dead-letter and attempt tables; do not expose global control tables through tenant APIs.
- Replay targets a specific scoped event and registered consumer, requires explicit authorization and a recorded reason, keeps original event identity, and creates an auditable new attempt. It cannot bypass validation or reset completed inbox records to repeat effects.
- Stop cleanly on shutdown; recover abandoned claims after lease expiry. Test crash after claim, after ledger commit before acknowledgement, and during retry scheduling.

Normal workers use a dedicated non-superuser role with constrained grants. Tenant-scoped processing must not depend on `ADMIN_DATABASE_URL`, `BYPASSRLS`, or caller-supplied tenant lists. Any scheduler that enumerates scopes must have a separate, narrowly constrained interface with explicit grants and no general payload-read privilege.

## 8. API, privacy, and operational controls

Extend current Fastify conventions; proposed route family: scoped business event list/detail and privileged per-event replay. Confirm exact route names and permission identifiers in reconciliation to avoid collisions.

Reads filter by verified business, event type, aggregate, correlation, and acceptance-time range. Default page size is 50, maximum 200. Enforce authorization before pagination and aggregation; foreign-scope cursors and event IDs cannot leak existence or payloads. Replay is a guarded POST with idempotency and audit, never an effect of a GET.

Reuse authentication, permissions, tenant context, applicable active-subscription enforcement, payload validation, correlation handling, audit, controlled errors, and rate limits. Register new permissions using repository conventions, without granting them to all users by default.

Payload policy favors minimal business facts and scoped references. Never log raw rejected payloads, tokens, credentials, or unnecessary personal information. Replay receipts and metrics expose sanitized metadata. The existing BO summaries and public product/order/register-session APIs remain compatible.

Monitor accepted counts, duplicates/conflicts, eligible backlog, oldest pending age, per-consumer failures, retries, dead letters, and lease recovery. Counts must identify their scope; a tenant-filtered zero cannot stand for global success. Readiness fails on unavailable database or invalid registry; health checks do not emit business events.

## 9. Migrations and rollout

The inspected BUILD-32 baseline reports migrations through 0170. This draft allocates no migration number and assumes no future highest value.

Run the actual repository tools immediately before implementation:

```text
node scripts/build-control/build-preflight.mjs BUILD-33
node scripts/build-control/allocate-next-migration.mjs
```

Preflight is expected to reject execution before BUILD-33 is frozen and made ready. Do not weaken it to accept this draft.

An additive migration is likely needed for ledger immutability, scope, durable leases, and per-consumer delivery state, unless later repository evidence proves equivalent facilities already exist. Final relation names, indexes, constraints, grants, and migration range belong in the reconciliation document before code. Keep old columns/APIs usable. Validate all prior migration checksums, empty installation, upgrade from the predecessor state, and the repository migration runner's idempotent rerun.

Deploy schema additions before the disabled worker. Enable only the initial event set and explicit scopes after validation. Rollback disables new ingestion/delivery and preserves accepted records and existing producer outbox writes; never roll back by deleting ledger history or rewriting frozen migrations.

## 10. Acceptance matrix

| Gate | Required evidence |
|---|---|
| Contract compatibility | Legacy exports still compile; each initial type has valid/invalid/version/size/identity adapter cases |
| Producer atomicity | Each initial emitter: rollback leaves neither domain mutation nor outbox event; commit leaves both |
| Ledger idempotency | Concurrent duplicates create one acceptance; mismatched content conflicts without overwrite |
| Scope isolation | Live non-owner, non-superuser tests for tenant, workspace, business, missing context, wrong parent ownership, foreign cursors, and reused pooled connections |
| Immutability | Application-role UPDATE/DELETE rejected; correction preserves original record |
| Delivery resilience | Two workers, two consumers, partial failure, lease expiry, stale acknowledgements, and crash recovery |
| Retry/replay | Transient recovery, terminal quarantine, authorized replay, repeated replay, and unauthorized replay; no duplicate effects |
| Existing handoffs | DA → BO and BO → BI success/rejection/acknowledgement/idempotency behavior unchanged; ledger receipt never substitutes for package acknowledgement |
| API | Authentication, permission, subscription where applicable, bounded inputs, sanitized errors, correlation, pagination, and replay idempotency |
| Schema | Empty install, predecessor upgrade, rerun, frozen checksums, grants and RLS tests |
| Regression | Affected packages, workspace lint/typecheck/build/test, completed-layer regression, browser compatibility, security/dependency checks, and required CI |
| Recovery and load | Documented fixture sizes, concurrent delivery/replay correctness, measured throughput/latency/backlog drain and indexes; no invented capacity promises |

Discover exact package/test commands from the implementation branch. Existing workspace commands include `pnpm lint`, `pnpm typecheck`, `pnpm build`, and `pnpm test` under `infinicus-platform`. PostgreSQL-backed tests must execute against a real database with an application role subject to RLS. Report failures and skips separately; infrastructure unavailability is not a pass. Do not suppress dependency findings or weaken validation to finish the build.

## 11. Exclusions

No full Commerce/Finance runtime, POS replacement, accounting journals, payroll, universal canonical-business-model redesign, domain event-sourcing conversion, new external connector, broker, webhook delivery, arbitrary subscriber URL, frontend dashboard, autonomous action, or rewrite of BI/DT/SIM/ADI/ABA/OM/CL. No renaming legacy event families just for architectural neatness. No rollout to every tenant, destructive history migration, or automatic execution of later builds.

## 12. Freeze, execution, and completion

Before freezing: review and accept this proposed scope, initial event set, ledger/transport separation, worker/replay model, conservative retention posture, and acceptance gates. Resolve reconciliation findings that materially change them. Record the approved specification checksum using the queue's existing convention.

Before ready: BUILD-32 must have its completion report, passing required validation, and completed queue status. Consume approved predecessor/legacy fixes from the proper integration base. Use a separate implementation branch. Only then register BUILD-33 in the manifest/state with dependency BUILD-32 and make it the single ready build. Freeze alone does not bypass the predecessor gate.

During execution: run preflight; reconcile; implement only this build; validate focused and full gates; document actual results. Do not reinterpret old event-backbone phase prompts as permission to execute every historical phase.

Required completion artifacts:

- `docs/architecture/BUILD-33-EVENT-RECONCILIATION.md` — inventory, ownership, contract and schema decisions, deviations.
- `docs/architecture/BUILD-33-EVENT-CATALOGUE.md` — supported producers/types/versions/consumers, payload policy and compatibility mappings.
- `docs/operations/BUILD-33-EVENT-RUNBOOK.md` — enable/disable, alerts, lease recovery, replay, rollback and deferred retention/import work.
- `.claude/state/reports/BUILD-33-BUSINESS-EVENT-ARCHITECTURE-completion.md` — commit/base, changes, actual migration range/checksums, exact commands and results, skips/failures, security/isolation evidence, operational limits and deferred work.

Mark completed and update the manifest only after all required gates pass and the implementation/report are committed and pushed. Keep `currentReadyBuild` null unless a subsequent build is separately specified and authorized. Stop before BUILD-34.

## 13. Draft validation record

This draft was checked against the BUILD-32 frozen specification, domain ownership map, BO reconciliation, existing event contract exports, migrations 0007/0011/0036, DA outbox wrappers, OperationalEventService, OperationalPublicationService, and outbox monitoring code. Historical phase prompts were treated as design references, not proof of implementation.

No runtime tests or production capacity claims are made for this document. No queue transition, schema modification, runtime implementation, or deployment was performed as part of specification preparation.
