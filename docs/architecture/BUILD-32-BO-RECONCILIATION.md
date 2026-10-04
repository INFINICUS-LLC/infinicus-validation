# BUILD-32 — BUSINESS OPERATIONS RECONCILIATION

Status: frozen pre-implementation reconciliation
Branch baseline: `build-32-business-operations-runtime`
Dependency: BUILD-31 completed
Audited migration baseline: `0001–0170`

## 1. Conclusion

BUILD-32 is a runtime/service reconciliation build over working persistence.
It is not a database rewrite.

The current repository already separates canonical shared entities from
Business Operations operational detail:

```text
platform.*
= canonical/shared master truth

business_operations.*
= operational detail, lifecycle, facts and handoff state
```

That split is correct and must be preserved.

## 2. Existing Stage-2C Business Operations persistence

Stage 2C is documented complete, validated and frozen.

Existing operational areas include:

- business profile extensions;
- department responsibilities and role assignments;
- leads/opportunities/customer accounts;
- quotations and quotation line items;
- order line items and order events;
- invoice line items/payment allocations/credit notes;
- purchase orders/line items/receipts;
- supplier agreements/performance;
- inventory balances/movements;
- warehouse zones/storage locations;
- fulfilment orders/items/delivery notes;
- employee assignments/work schedules;
- tasks/task assignments/workflow instances;
- resource bookings;
- maintenance schedules/records;
- asset inspections;
- expense claims/items;
- support cases/case activities;
- compliance controls;
- risk assessments;
- incidents/escalations;
- operational performance;
- BO publication packages/handoff records;
- BO assembly/deployment metadata.

Later compatible additions include:

- `business_operations.business_events`;
- `business_operations.products`;
- `business_operations.register_sessions`.

## 3. Canonical shared entities

Do not duplicate these existing master entities:

- `platform.orders`
- `platform.invoices`
- `platform.payments`
- `platform.customers`
- `platform.suppliers`
- `platform.employees`
- `platform.inventory_items`
- `platform.warehouses`
- any canonical `platform.products` representation that exists on the current branch

Operational tables attach behavior/detail to canonical entities.

## 4. Current repository adapters

Observed BO repository exports:

| Repository | BUILD-32 classification | Decision |
|---|---|---|
| LeadRepository | future COMMERCE/customer pipeline | ADAPT |
| OpportunityRepository | future COMMERCE/customer pipeline | ADAPT |
| PurchaseOrderRepository | OPERATIONS/procurement | EXTEND |
| SupportCaseRepository | future service/commerce compatibility | KEEP |
| IncidentRepository | OPERATIONS/risk support | KEEP |
| TaskRepository | OPERATIONS/workforce/workflow | KEEP |
| InventoryBalanceRepository | OPERATIONS/inventory | EXTEND |
| BusinessEventRepository | compatibility fact ledger | KEEP |
| ProductRepository | future COMMERCE/catalog | ADAPT |
| RegisterSessionRepository | future COMMERCE/POS | ADAPT |
| OrderRepository | future COMMERCE/order lifecycle | ADAPT |

No repository above should be deleted merely because long-term domain ownership
changes.

## 5. Existing API surfaces

Observed routes:

- operational business-event logging and KPI summary;
- products/catalog;
- register sessions;
- orders.

Current route protections already use:

- authentication;
- resolved tenant context;
- `bo:read` / `bo:write`;
- active subscription on mutations;
- idempotency key on mutations;
- BusinessRepository ownership checks.

Decision: KEEP public compatibility. BUILD-32 may introduce service boundaries
behind those routes, but must not destructively rename or relocate public APIs.

## 6. Existing handoffs

### DA/DAL → BO

Canonical contract:
`packages/handoff-contracts/src/dal-to-bo.ts`

Decision: KEEP and CONSUME.

The contract already preserves:
- tenant/workspace/business scope;
- package/version;
- target layer/block;
- published status;
- record count;
- source reference;
- quality/reliability;
- schema reference;
- provenance;
- consent references;
- limitations/warnings;
- idempotency.

BUILD-32 must implement/complete the receiving runtime, not replace the
contract.

### BO → BI

Canonical contract:
`packages/handoff-contracts/src/bo-to-bi.ts`

Canonical persistence:
- `business_operations.bo_publication_packages`
- `business_operations.bo_handoff_records`

Decision: KEEP and PUBLISH THROUGH.

## 7. Existing event backbone

Existing typed BO events include:

- `bo.lead.created`
- `bo.lead.converted`
- `bo.opportunity.stage_changed`
- `bo.quotation.sent`
- `bo.order.authorized`
- `bo.order.completed`
- `bo.invoice.issued`
- `bo.payment.received`
- `bo.purchase_order.approved`
- `bo.inventory.movement_recorded`
- `bo.fulfilment.dispatched`
- `bo.support_case.opened`
- `bo.support_case.resolved`
- `bo.incident.raised`
- `bo.incident.resolved`
- `bo.data.published`

Decision: REUSE before extending. Do not create a second event bus.

## 8. High-risk reconciliation findings

### 8.1 Inventory balance mutation

`InventoryBalanceRepository.adjustQuantity()` directly modifies
`quantity_on_hand`.

Risk: operational stock drift can occur if a balance changes without a matching
inventory movement/evidence event.

BUILD-32 action:
- inspect current movement repository/table/event wrappers;
- route stock-changing runtime behavior through auditable movement semantics;
- preserve compatibility for existing callers where possible.

Classification: EXTEND.

### 8.2 Purchase-order lifecycle

`PurchaseOrderRepository.updateStatus()` accepts a generic status string.

Risk: a service caller could bypass intended lifecycle sequencing if database
constraints alone are insufficient.

BUILD-32 action:
- inspect actual CHECK constraints and current tests;
- add explicit runtime transition policy;
- preserve current repository compatibility unless a correctness issue
requires a guarded adapter.

Classification: EXTEND.

### 8.3 Order business ownership

`OrderRepository` correctly uses `platform.orders` as canonical order truth
and BO line items/events as operational detail.

BUILD-32 action:
- verify every route/business-scoped mutation proves the loaded order belongs
to the route business;
- preserve public API;
- classify long-term ownership as COMMERCE.

Classification: ADAPT.

### 8.4 Product/catalog duplication

Repository comments acknowledge a lightweight
`business_operations.products` catalog and a separate richer canonical
product model.

BUILD-32 action:
- document exact current representations;
- create compatibility adapter/service semantics if needed;
- no destructive merge in BUILD-32.

Classification: ADAPT / DEPRECATE-LATER depending on repository reality.

### 8.5 Register sessions

Register sessions are operationally implemented under BO but conceptually
belong to future COMMERCE/POS.

BUILD-32 action:
- preserve implementation/API;
- keep financial reconciliation effects out of FINANCE until the dedicated
Finance build;
- do not expand into a full POS build.

Classification: ADAPT.

### 8.6 business_events

`business_operations.business_events` is a lightweight append-only operational
fact ledger.

BUILD-32 action:
- preserve it;
- use where existing code depends on it;
- do not promote it into the universal cross-domain Event Ledger.

Classification: KEEP.
Future canonical Event Ledger: BUILD-33.

## 9. Runtime gap

The repository has persistence and route-level operations but does not expose a
single canonical production Business Operations runtime equivalent to the
BUILD-31 Data Acquisition runtime.

BUILD-32 therefore creates or extends a service boundary containing:

- BusinessIntakeService
- IntakeMapperRegistry
- InventoryService
- ProcurementService
- SupplierService
- WorkforceService
- AssetService
- OperationalEventService
- OperationalPublicationService

## 10. Migration decision

Current evidence does not justify a schema rewrite.

Default BUILD-32 migration decision:

```text
NO MIGRATION
```

A new migration is allowed only if implementation proves a frozen requirement
cannot be satisfied by existing persistence.

## 11. Component decisions

```text
KEEP
- canonical platform entities
- Stage-2C schema
- RLS
- existing handoff contracts
- existing outbox/event backbone
- business_events compatibility ledger
- existing public API compatibility

EXTEND
- PurchaseOrderRepository lifecycle safety
- InventoryBalanceRepository auditable mutation path
- runtime service orchestration
- BO publication runtime

ADAPT
- products/catalog
- orders
- register sessions
- customer pipeline concepts
- other future-domain compatibility surfaces

DEPRECATE-LATER
- duplicate/lightweight concepts proven superseded by a canonical future domain
  after a compatibility window

NOT-IN-BUILD-32
- general ledger
- AP/AR
- banking
- COGS accounting
- full POS
- universal Event Ledger
- Digital Twin/Simulation/ADI rewrites
```

## 12. Implementation order

1. Verify branch/preflight/migration state.
2. Freeze ownership map.
3. Define runtime package interface.
4. Implement DA → BO intake consumer.
5. Implement mapper registry/commands.
6. Implement Inventory runtime.
7. Implement Procurement runtime.
8. Implement Supplier runtime.
9. Implement Workforce runtime.
10. Implement Asset runtime.
11. Reconcile Commerce compatibility adapters.
12. Implement governed BO → BI publication.
13. Wire API only where additive/required.
14. Run focused + integration + regression gates.
15. Completion report and queue transition.
16. Stop before BUILD-33.
