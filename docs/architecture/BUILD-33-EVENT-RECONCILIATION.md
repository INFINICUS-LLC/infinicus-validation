# BUILD-33 event reconciliation

Baseline: ad6440c538c965ce553f0e911610b59991825526 (merged BUILD-32). Approved scope: BUILD-33 frozen specification.

| Component | Classification | Decision |
|---|---|---|
| events.outbox_events and typed DA/BO emitters | KEEP | Committed source of events; no second transport and no change to existing outbox delivery status |
| events.inbox_events | EXTEND | Nullable legacy-compatible scope/lease/attempt/snapshot columns; consumer-local processing |
| events.event_delivery_attempts | EXTEND | Consumer identity distinguishes fan-out attempts; existing uniqueness remains for legacy consumer |
| events.dead_letter_events | EXTEND | Scoped event/consumer references for BUILD-33 failures |
| events.event_subscriptions | KEEP | Existing global routing remains untouched; BUILD-33 registrations are trusted code, initially ledger only |
| PlatformEvent and event-contracts exports | ADAPT | Separate canonical business envelope; legacy exports retained |
| business_operations.business_events | KEEP | Existing compatibility ledger and summary APIs remain separate |
| DA to BO and BO to BI | KEEP | No business intake or acknowledgement is driven by ledger delivery |
| New immutable ledger | EXTEND | DATA-owned events.business_event_ledger, backed by existing outbox and inbox |
| Activation/checkpoint | EXTEND | Explicit business scope with serialized acceptance counter and activation boundary |
| Legacy global monitoring | KEEP | New metrics scoped to activated business; never report scope-filtered zero as global health |
| External brokers, wildcard consumers, historical backfill | NOT-IN-BUILD-33 | No automatic rollout or replay of historical events |

The existing preflight checks file presence and emits metadata, but does not enforce queue readiness/checksums. A dedicated BUILD-33 preflight will enforce those constraints without changing historical build semantics.

Migration 0171 is next at this baseline; allocation must be checked again before creation. No prior migration may change. New RLS policies require tenant, workspace, and business context; no superuser worker. Global legacy tables are not exposed through new APIs. Existing broad app grants mean immutability needs database triggers in addition to application checks.

Legacy wrappers omit business_id on the outbox. Resolve scope through exact registered aggregate tables: DA publication_packages, BO inventory_movements, purchase_orders, bo_publication_packages. Always require tenant/workspace and payload aggregate identity to match. Preserve source payload and headers in the frozen canonical snapshot; retries do not reread mutable business facts. The worker only accepts the four frozen event types and v1.0 payloads.

Operational decisions: explicit activation, worker disabled by default, no tenant enumeration, one configured scope per worker invocation. Activation establishes a timestamp boundary; preactivation transactions/backlog are historical and require separately reviewed import. Delivery uses independent inbox rows and fenced renewable leases. Ledger acceptance uses a locked per-business counter for commit-ordered pagination rather than a PostgreSQL sequence, preventing late commits falling behind a cursor watermark.
