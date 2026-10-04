# BUILD-33 — Pre-Implementation Reconciliation

**Build:** BUILD-33 — Cross-Domain Business Event Architecture
**Status:** RECONCILED FOR SPEC FREEZE
**Baseline:** merged BUILD-32 on main
**Migration baseline:** 0001–0170; no 0171 migration exists

## Findings

- The established cross-domain event infrastructure is the `events` schema:
  `outbox_events`, `inbox_events`, `dead_letter_events`,
  `event_subscriptions`, and `event_delivery_attempts`.
- `events.outbox_events` is mutable delivery state, not an immutable event ledger.
- `business_operations.business_events` is an Operations compatibility fact
  ledger, not a cross-domain canonical ledger.
- `@infinicus/event-contracts` exists and is the correct contract package.
- `@infinicus/handoff-contracts` remains separate and must not be replaced.
- DA, BO, BI, DT, SIM, ADI, ABA, OM and CL already use transactional outbox
  conventions through existing SQL emitters.
- Historical Event Backbone Phase 2/3 documents exist, but the corresponding
  eventing repositories/relay implementations are not present.
- Existing event infrastructure predates strict workspace scoping in places.
  BUILD-33 must enforce tenant + workspace isolation in the canonical ledger
  and repository APIs without rewriting frozen migrations.
- No immutable `business_event_ledger` exists.

## Locked implementation boundary

BUILD-33 will extend existing packages:

```text
packages/event-contracts/         envelope, schemas, registry, aliases
packages/database/src/eventing/  persistence/repositories/transactions
packages/observability/          event metrics/logging integration
```

BUILD-33 is authorized to add an immutable
`events.business_event_ledger` additively, conceptually owned by
DATA → Event Ledger.

It must preserve the existing outbox/inbox/dead-letter/subscription structures,
legacy event producers, handoff contracts, and `business_operations.business_events`.

## Migration decision

Highest verified migration: `0170`.

If persistence changes are required, BUILD-33 starts at `0171` and continues
sequentially. Migrations 0001–0170 remain immutable.

## Freeze readiness

- [x] BUILD-32 completed
- [x] BUILD-32 merged to main
- [x] migration baseline verified
- [x] event-contract package inspected
- [x] handoff contracts inspected
- [x] event infrastructure inspected
- [x] BO/DA producer conventions inspected
- [x] historical event-backbone docs reconciled
- [x] canonical ledger gap confirmed
- [x] package boundary resolved
- [x] destructive migration excluded

The BUILD-33 specification may be frozen. Implementation remains unstarted.
