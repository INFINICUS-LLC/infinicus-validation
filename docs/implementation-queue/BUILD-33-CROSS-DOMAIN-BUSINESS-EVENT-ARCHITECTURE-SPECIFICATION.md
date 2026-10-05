# BUILD-33 — Cross-Domain Business Event Architecture Specification

**Specification version:** 1.1  
**Build ID:** BUILD-33  
**Domain owner:** DATA → Event Infrastructure / Event Ledger  
**Status:** FROZEN — AMENDED BY ARCHITECTURE GUARDRAIL RECONCILIATION  
**Dependency:** BUILD-32 — COMPLETED AND MERGED  
**Migration baseline before BUILD-33:** 0001–0170  
**First permitted BUILD-33 migration:** 0171  
**Implementation state:** IN_PROGRESS — PAUSED AT ARCHITECTURE GATE  
**Governing architecture:** INFINICUS Master Architecture Guardrail v1.0  
**Amendment record:** docs/architecture/BUILD-33-ARCHITECTURE-GUARDRAIL-RECONCILIATION-v1.1.md

## 0. Version history

### v1.0

Original frozen BUILD-33 specification defining the canonical cross-domain
Business Event Architecture.

### v1.1

Architecture-preserving amendment. Adds mandatory dual-architecture validation,
Cold-Start evidence classification, explicit source-of-truth restrictions,
approval/action replay constraints, and a compatibility hold on migration 0172.

No domain/layer ownership is reassigned.

---

## 1. Architectural position

BUILD-33 must preserve two coexisting architectures.

### Platform domains

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

DATA owns event infrastructure, contracts, schema registry, provenance, lineage
and canonical event history.

### Nine-layer decision lifecycle

```text
Data Acquisition
↓
Business Operations
↓
Business Intelligence
↓
Business Digital Twin
↓
Simulation
↓
AI Decision Intelligence
↓
Approved Business Action
↓
Outcome Monitoring
↓
Continuous Learning
↺
```

BUILD-33 supports all nine layers but replaces none of them.

---

## 2. Objective

Establish one canonical, tenant-aware, versioned, replay-safe and
provenance-preserving Business Event Architecture.

Domain/layer state remains authoritative in its owning boundary.

The Event Ledger owns immutable event evidence and lineage only.

---

## 3. Existing infrastructure to reuse

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

---

## 4. Canonical Business Event envelope

Extend `@infinicus/event-contracts` additively.

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
provenance
schemaName
schemaVersion
sensitivity
```

`provenance` is mandatory for canonical events and must contain:

```text
evidenceClass =
  ACTUAL
  ASSUMPTION_BASED
  BENCHMARK_BASED
  ESTIMATED
  FORECAST
  SIMULATION
```

plus optional stable source references.

Legacy events may enter through an explicit compatibility adapter that assigns a
documented evidence class. The ledger must never silently default non-observed
evidence to ACTUAL.

---

## 5. Source-of-truth rule

The Event Ledger must never become the authoritative business-state database.

Examples:

```text
Commerce owns orders/sales/customers/payments.
Operations owns inventory/procurement/suppliers/workforce/assets.
Finance owns ledger/cash/payables/receivables/budgets.
Business Administration owns profile/roles/permissions/policies/authority.
BI owns analytical evidence.
Digital Twin owns modeled current state.
Simulation owns possible future outcomes.
ADI owns recommendations.
ABA owns formal authorization.
Outcome Monitoring owns verified post-action results.
Continuous Learning owns learning artifacts.
```

DATA records and governs event evidence about these facts; it does not acquire
ownership of the underlying state.

---

## 6. Event identity and immutability

Every canonical event has one globally unique immutable event ID.

Canonical ledger records are append-only. Corrections, reversals and
superseding facts are new events.

Delivery status must remain outside immutable event history.

---

## 7. Canonical naming

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

Legacy aliases remain explicitly mapped.

---

## 8. Compatibility mappings

At minimum:

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

Ambiguous events such as `bo.payment.received` remain unmapped until ownership
is resolved.

---

## 9. Contract registry

The runtime registry records:

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

Unknown/unsupported versions fail validation.

Registry metadata must not transfer source-of-truth ownership.

---

## 10. Canonical Event Ledger

BUILD-33 may introduce:

```text
events.business_event_ledger
```

It must:

- persist the canonical envelope;
- persist evidence classification;
- preserve provenance;
- be append-only;
- enforce fail-closed tenant/workspace RLS;
- prevent application-role mutation;
- remain non-authoritative for domain state.

---

## 11. Outbox relationship

```text
authoritative domain transaction
        ├── authoritative domain state
        └── events.outbox_events
                 ↓
        canonical validation/publication
                 ↓
        events.business_event_ledger
                 ↓
        governed consumers
```

The Event Ledger cannot replace the authoritative domain transaction store.

---

## 12. Eventing repositories

Implement under:

```text
infinicus-platform/packages/database/src/eventing/
```

Responsibilities:

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

These repositories access event infrastructure only. They are not generic
cross-domain table access services.

---

## 13. Delivery and idempotency

```text
at-least-once delivery
+
idempotent consumer effects
```

Inbox uniqueness remains `(event_id, consumer_name)`.

Stable producer idempotency keys are required where producer semantics support
them.

---

## 14. Correlation, causation and traceability

Preserve correlation through the business workflow.

Set causation to the immediate triggering event.

Never reuse an event ID for a derived event.

Where applicable preserve references through:

```text
source data
→ operational event
→ BI evidence
→ Twin snapshot
→ Simulation run
→ Decision
→ Approval
→ Execution
→ Outcome
→ Learning
```

---

## 15. Cold-Start rule

BUILD-33 must preserve zero-data operation.

Assumption/benchmark/estimate/forecast/simulation-derived events remain clearly
classified and must never be represented as ACTUAL simply because they are
persisted in the ledger.

Downstream consumers must be able to inspect the evidence class.

---

## 16. Approval/action boundary

The valid decision/execution flow remains:

```text
Simulation
↓
AI Decision Intelligence
↓
Approved Business Action
↓
owning execution domain / Business Operations
↓
Real-world execution
```

Event publication/replay must never bypass ABA authorization.

Outcome Monitoring may emit evidence/alerts but must not directly mutate
Operations/Commerce/Finance through event replay.

---

## 17. Tenant/workspace/global scope

Canonical tenant-owned event rows require tenant/workspace context.

Historical event infrastructure may also contain tenant-global or
platform-global control-plane records.

Therefore BUILD-33 must distinguish:

```text
TENANT_WORKSPACE
TENANT_GLOBAL
PLATFORM_GLOBAL
```

before changing policies on historical event transport tables.

Strict tenant/workspace RLS must not silently hide legitimate global
subscriptions or historical delivery records.

---

## 18. Migration policy

Migrations 0001–0170 remain immutable.

### 0171

The canonical Event Ledger migration is permitted, subject to v1.1 provenance
and Cold-Start requirements before BUILD-33 completion.

### 0172

The current draft `0172_harden_eventing_scope.sql` is under
**ARCHITECTURE COMPATIBILITY HOLD** and is not merge-ready.

It must be redesigned to preserve global/legacy event-transport semantics while
enforcing tenant/workspace isolation for tenant-owned data.

No later BUILD-33 migration may depend on the current 0172 behavior until that
redesign is accepted.

---

## 19. Replay, retry and dead-letter

Reuse existing infrastructure where compatible.

Replay must:

- preserve original event/evidence classification;
- preserve correlation lineage;
- create new replay/delivery evidence;
- require explicit authorization;
- never automatically re-run irreversible business actions;
- never bypass Approved Business Action.

Failed events must never disappear silently.

---

## 20. Sensitive data

Do not put passwords, API keys, access/refresh tokens, database credentials,
private keys, raw card data, session secrets or binary documents in canonical
event payloads.

Use stable references.

---

## 21. Guided Mode compatibility

BUILD-33 has no direct UX deliverable, but events must retain enough metadata for
Experience-layer guidance to explain:

- what happened;
- evidence class;
- source/provenance;
- causal chain;
- linked decision/action/outcome where applicable.

---

## 22. Required tests

At minimum:

```text
canonical envelope validation
mandatory evidence classification
non-ACTUAL provenance preservation
registry duplicate/version handling
legacy alias mapping
tenant isolation
workspace isolation
global-scope compatibility
missing-context denial
ledger immutability
idempotent canonical publication
outbox→ledger preservation
correlation propagation
causation propagation
inbox duplicate suppression
consumer retry
dead-letter persistence
replay authorization
ABA bypass prevention
secret rejection
transaction rollback atomicity
historical/global subscription compatibility
```

Persistence/RLS behavior requires live PostgreSQL tests.

---

## 23. Validation gates

Before completion:

```bash
pnpm install --frozen-lockfile
pnpm workspace:validate
pnpm lint
pnpm typecheck
pnpm build
pnpm test
live PostgreSQL eventing/RLS tests
dependency/security checks
migration gate
container smoke/DAST where affected
```

Required database tests may not silently skip.

---

## 24. Explicit exclusions

BUILD-33 does not implement:

```text
BUILD-34 Financial Transaction Engine
accounting ledger
POS redesign
Business Administration redesign
BI/DT/SIM/ADI redesign
Outcome Monitoring execution logic
Continuous Learning redesign
Kafka
RabbitMQ
external broker migration
event sourcing every domain
full CQRS rewrite
UI redesign
production deployment
```

---

## 25. Stop conditions

Stop if:

- domain ownership would change;
- layer ownership would change;
- a source of truth would be duplicated;
- Cold-Start provenance would be lost;
- replay could bypass ABA;
- global event-control semantics would be broken;
- compatibility requires destructive migration;
- tenant/workspace isolation cannot be proven;
- required validation cannot execute.

---

## 26. Completion evidence

The completion report must record:

- v1.1 architecture compliance;
- exact migration baseline before/after;
- final 0171/0172 disposition;
- evidence-class contract;
- producer/consumer inventory;
- source-of-truth review;
- contract compatibility;
- tenant/workspace/global-scope evidence;
- idempotency evidence;
- replay/ABA safety evidence;
- Cold-Start provenance evidence;
- test commands/counts;
- security review;
- rollback procedure;
- known limitations.

---

## 27. Success criteria

BUILD-33 completes only when:

- canonical envelope exists;
- evidence classification is mandatory and preserved;
- contract registry is operational;
- immutable Event Ledger exists;
- source-of-truth ownership remains unchanged;
- tenant/workspace/global scope is correct;
- event records are immutable;
- versioning/idempotency are enforced;
- correlation/causation are preserved;
- existing outbox/handoff contracts remain intact;
- legacy aliases remain controlled;
- replay cannot bypass ABA;
- Cold Start remains valid;
- required tests pass;
- completion report exists;
- BUILD-34 is untouched.

---

## 28. Queue rule

BUILD-33 remains `in_progress` but implementation is paused at the architecture
gate until the v1.1-required provenance and 0172 compatibility corrections are
implemented.

PR #22 remains draft and must not merge until the v1.1 completion gate is green.
