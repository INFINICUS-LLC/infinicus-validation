# BUILD-33 — Cross-Domain Business Event Architecture Specification

**Build ID:** BUILD-33
**Domain:** DATA → Event Ledger
**Status:** FROZEN
**Dependency:** BUILD-32 — COMPLETED AND MERGED
**Migration baseline:** 0001–0170
**First permitted migration:** 0171, only if required
**Implementation state:** NOT STARTED

## 1. Objective

BUILD-33 establishes one canonical, tenant-aware, versioned and replay-safe
Business Event Architecture across the locked INFINICUS domains:

```text
EXPERIENCE
BUSINESS ADMINISTRATION
COMMERCE
OPERATIONS
FINANCE
DATA
INTELLIGENCE
CONTROL LOOP
```

Domain state remains authoritative in its owning domain. DATA → Event Ledger
owns canonical event recording, lineage, replay semantics and governance.

## 2. Existing infrastructure to reuse

BUILD-33 must build on, not replace:

```text
events.outbox_events
events.inbox_events
events.dead_letter_events
events.event_subscriptions
events.event_delivery_attempts
business_operations.business_events
@infinicus/event-contracts
@infinicus/handoff-contracts
existing DA/BO/BI/DT/SIM/ADI/ABA/OM/CL outbox emitters
```

The outbox is delivery state. It is not the immutable canonical ledger.

## 3. Canonical Business Event envelope

Extend `@infinicus/event-contracts` with an additive canonical envelope that
does not break the legacy shared `PlatformEvent` type.

Required fields:

```text
eventId
eventType
eventVersion
tenantId
workspaceId
businessId nullable
sourceDomain
sourceService
aggregateType
aggregateId
correlationId
causationId nullable
occurredAt
recordedAt
actor nullable
idempotencyKey nullable
payload
metadata
provenance nullable
schemaName
schemaVersion
sensitivity
```

Canonical source domains are:

```text
experience
business_administration
commerce
operations
finance
data
intelligence
control_loop
```

## 4. Event identity and immutability

Every canonical event has one globally unique immutable event ID.

Canonical ledger records are append-only. Corrections, reversals and
superseding facts must be represented as new events, never UPDATE/DELETE of
historical facts.

## 5. Naming convention

Canonical events use:

```text
<domain>.<aggregate>.<event>
```

Examples:

```text
commerce.order.completed
operations.inventory.movement_recorded
operations.purchase_order.approved
finance.invoice.issued
data.acquisition.package_published
intelligence.forecast.generated
control_loop.action.approved
```

Legacy names remain aliases during migration.

## 6. Compatibility mappings

The contract registry must include explicit aliases, including at least:

```text
da.data.published
  → data.acquisition.package_published

bo.inventory.movement_recorded
  → operations.inventory.movement_recorded

bo.purchase_order.approved
  → operations.purchase_order.approved

bo.order.completed
  → commerce.order.completed

bo.invoice.issued
  → finance.invoice.issued
```

Ambiguous legacy events such as `bo.payment.received` must remain unmapped
until semantic ownership is explicitly resolved.

## 7. Contract registry

Extend `@infinicus/event-contracts` with a runtime registry containing:

```text
eventType
eventVersion
schemaName
schemaVersion
ownerDomain
producer
supportedConsumers
sensitivity
status
effectiveFrom
deprecatedAt
compatibilityAliases
validator
```

Unknown or unsupported event versions must fail validation.

## 8. Canonical Event Ledger

Reconciliation confirmed that no immutable cross-domain ledger exists.

BUILD-33 is authorized to introduce:

```text
events.business_event_ledger
```

The ledger must contain the canonical envelope fields, be append-only, and
enforce tenant + workspace RLS.

It must not contain mutable consumer-delivery state.

## 9. Outbox relationship

Required architecture:

```text
authoritative domain transaction
        ├── domain state
        └── events.outbox_events
                 ↓
        canonical validation/publication
                 ↓
        events.business_event_ledger
                 ↓
        governed consumers
```

Do not convert `events.outbox_events` into the ledger.

## 10. Eventing repositories

Implement under:

```text
infinicus-platform/packages/database/src/eventing/
```

Required responsibilities:

```text
EventLedgerRepository
OutboxRepository
InboxRepository
DeadLetterRepository
EventSubscriptionRepository
EventDeliveryAttemptRepository
EventTransaction
eventing-types
eventing-errors
```

No duplicate event persistence package is authorized unless preflight proves
these responsibilities cannot fit the established packages.

## 11. Idempotency and delivery

Delivery semantics:

```text
at-least-once delivery
+
idempotent consumers
```

Inbox uniqueness remains `(event_id, consumer_name)`.

Canonical publication must support a stable producer idempotency key and must
not create duplicate logical facts during retries.

## 12. Correlation, causation and ordering

Preserve correlation ID through the whole workflow.

Set causation ID to the immediate triggering event.

Never reuse event IDs for derived events.

Do not promise global ordering. Aggregate-scoped ordering is the default where
ordering matters.

## 13. Tenant/workspace security

Canonical event operations must:
- require tenant and workspace context;
- use tenant-scoped transactions;
- enforce tenant + workspace RLS;
- block cross-tenant reads/writes;
- block same-tenant cross-workspace access;
- fail closed without context;
- prevent application-role RLS bypass.

Privileged relay claiming may use a system role only for delivery mechanics;
domain processing must re-enter tenant/workspace context.

## 14. Sensitive data

Event payloads must never contain passwords, API keys, access/refresh tokens,
database credentials, private keys, raw card data, session secrets or binary
documents.

Use stable references instead.

## 15. Replay, retry and dead-letter

Reuse the existing dead-letter and delivery-attempt infrastructure.

Replay must preserve the original event and correlation lineage, create new
replay/delivery evidence, validate current contract support, require explicit
authorization and never automatically repeat irreversible external effects.

Permanent failures must not retry indefinitely. No failed event may be silently
discarded.

## 16. Observability

Reuse existing observability infrastructure.

Required operational signals include outbox backlog, oldest pending age, ledger
append latency, event throughput, publish success/failure, consumer lag, retry
count, dead-letter count, duplicate suppression, schema validation failure and
replay outcome.

## 17. Handoff contracts

Existing handoff contracts remain authoritative semantic interfaces.

```text
handoff contract = governed layer payload transfer
business event   = immutable fact that something happened
```

BUILD-33 does not replace DAL→BO, BO→BI or later handoff contracts.

## 18. Migration policy

Migrations 0001–0170 are frozen.

If BUILD-33 requires persistence changes, the first migration is `0171`,
followed sequentially.

No historical migration may be rewritten or renumbered.

## 19. Required tests

At minimum:

```text
canonical envelope validation
contract registry/version handling
legacy alias mapping
tenant isolation
workspace isolation
missing-context denial
ledger immutability
idempotent canonical publication
outbox→ledger preservation
correlation propagation
causation propagation
inbox duplicate suppression
consumer retry
dead-letter persistence
replay safety
secret rejection
aggregate ordering where required
transaction rollback atomicity
```

Persistence and RLS behavior require live PostgreSQL tests.

## 20. Validation gates

Before BUILD-33 can complete:

```bash
pnpm install --frozen-lockfile
pnpm workspace:validate
pnpm lint
pnpm typecheck
pnpm build
pnpm test
live PostgreSQL eventing integration tests
dependency/security checks
migration gate
container smoke/DAST where affected
```

Required database tests must not silently skip in CI.

## 21. Explicit exclusions

BUILD-33 does not implement:

```text
BUILD-34 Financial Transaction Engine
full accounting ledger
POS redesign
Business Administration redesign
BI/DT/SIM/ADI redesign
Kafka
RabbitMQ
external broker migration
event sourcing every domain
full CQRS rewrite
UI redesign
production deployment
```

## 22. Stop conditions

Stop implementation if:
- the migration baseline no longer matches 0001–0170 before first change;
- an equivalent immutable ledger appears;
- required producer/consumer ownership is ambiguous;
- tenant/workspace isolation cannot be proven;
- compatibility requires destructive migration;
- domain ownership would be changed;
- required validation cannot be executed.

## 23. Completion evidence

The completion report must record the exact migration baseline, modified files,
canonical contracts, compatibility mappings, producer/consumer inventory,
validation commands/results, tenant/RLS evidence, idempotency evidence,
replay-safety evidence, security review and known limitations.

## 24. Success criteria

BUILD-33 is complete only when:
- one canonical Business Event envelope exists;
- the contract registry is operational;
- the immutable cross-domain Event Ledger exists;
- tenant/workspace context is mandatory;
- event records are immutable;
- versioning and idempotency are enforced;
- correlation/causation are preserved;
- the existing outbox is preserved;
- required legacy aliases are mapped;
- handoff contracts remain intact;
- replay/dead-letter behavior is controlled;
- observability is integrated;
- required tests pass;
- the completion report exists;
- no BUILD-34 implementation is included.

## 25. Queue rule

This frozen specification authorizes BUILD-33 to be marked **ready** only.

Implementation begins only after an explicit transition to `in_progress`.
No BUILD-33 runtime implementation is part of the specification-freeze commit.
