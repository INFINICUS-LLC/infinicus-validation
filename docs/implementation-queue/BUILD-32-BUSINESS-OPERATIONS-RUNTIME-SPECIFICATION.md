# BUILD-32 — BUSINESS OPERATIONS RUNTIME — FROZEN SPECIFICATION

## 1. Build identity

- Build ID: `BUILD-32`
- Layer: `BUSINESS-OPERATIONS-RUNTIME`
- Name: `Business Operations Runtime`
- Dependency: `BUILD-31`
- Status: `ready`
- Runtime implementation: yes
- Verified migration baseline before build: `0001–0170`
- Primary objective: turn the existing Business Operations persistence into the canonical production runtime for the locked OPERATIONS domain without rewriting existing schemas or collapsing COMMERCE or FINANCE into it.

## 2. Locked business architecture

```text
INFINICUS
├── EXPERIENCE
├── BUSINESS ADMINISTRATION
├── COMMERCE
├── OPERATIONS
├── FINANCE
├── DATA
├── INTELLIGENCE
└── CONTROL LOOP
```

BUILD-32 owns:

```text
OPERATIONS
├── Inventory
├── Procurement
├── Suppliers
├── Workforce
└── Assets
```

BUILD-32 must not claim canonical ownership of:

```text
COMMERCE
├── POS
├── Orders
├── Payments
├── Customers
└── Refunds

FINANCE
├── Transaction Engine
├── Accounting Ledger
├── Accounts Payable
├── Accounts Receivable
├── Banking
└── Financial Statements
```

Existing Business Operations persistence may contain compatibility records for
future domains. Preserve them until their future owning runtime is implemented.

## 3. Non-negotiable principles

1. Repository reality determines current state.
2. Reuse before creating.
3. Extend before replacing.
4. Add adapters before destructive relocation.
5. Never edit or renumber committed migrations.
6. Preserve BUILD-31 DA → BO publication.
7. Preserve tenant/workspace/business isolation.
8. Preserve correlation, causation, lineage, provenance and quality.
9. Keep runtime logic in `infinicus-platform`, not in `index.html`.
10. No duplicate source of truth.
11. Reuse authentication, authorization, RLS, subscription, audit, observability and idempotency.
12. No direct writes into BI, DT, SIM, ADI, ABA, OM or CL persistence.
13. Domain mutation and outbox publication must be atomic when an event is emitted.
14. Financial/accounting truth belongs to later FINANCE builds.
15. BUILD-33 owns the future canonical cross-domain Business Event Architecture.

## 4. Verified baseline

The repository already contains:

- Stage 2C `business_operations` schema with 48 tables.
- canonical master entities in `platform.*`.
- fail-closed tenant/workspace RLS.
- BO indexes, triggers and typed outbox event functions.
- BO repositories.
- `bo_publication_packages` and `bo_handoff_records`.
- canonical DAL/DA → BO and BO → BI handoff contracts.
- `business_operations.business_events`.
- `business_operations.products`.
- `business_operations.register_sessions`.
- Fastify API routes for existing operational events, products, register sessions and orders.
- authentication/authorization, subscription, audit, observability and idempotency infrastructure.

Canonical entities that must not be duplicated include current
`platform.orders`, `platform.invoices`, `platform.payments`,
`platform.customers`, `platform.suppliers`, `platform.employees`,
`platform.inventory_items` and `platform.warehouses`.

## 5. Reconciliation gate

Before runtime implementation create and freeze:

- `docs/architecture/BUILD-32-BO-RECONCILIATION.md`
- `docs/architecture/BUILD-32-DOMAIN-OWNERSHIP-MAP.md`

Every existing BO component must be classified:

```text
KEEP
EXTEND
ADAPT
DEPRECATE-LATER
NOT-IN-BUILD-32
```

Explicitly reconcile:

- `business_operations.products` versus any canonical `platform.products`.
- Orders: canonical `platform.orders`, BO operational detail, long-term COMMERCE ownership.
- Register sessions: compatibility now, long-term COMMERCE/POS ownership.
- Purchase orders: OPERATIONS lifecycle; AP accounting remains FINANCE.
- Inventory: operational movement/balance is OPERATIONS; COGS/accounting remains FINANCE.
- Supplier operations versus supplier financial balances.
- Workforce scheduling versus BUSINESS ADMINISTRATION master hierarchy.
- Asset operations versus FINANCE depreciation.
- `business_events` as compatibility fact ledger, not the future universal Event Ledger.

## 6. Runtime package

Create or extend the canonical equivalent of:

```text
infinicus-platform/packages/business-operations-runtime/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts
│   ├── types.ts
│   ├── errors.ts
│   ├── BusinessOperationsService.ts
│   ├── intake/
│   │   ├── BusinessIntakeService.ts
│   │   └── IntakeMapperRegistry.ts
│   ├── inventory/InventoryService.ts
│   ├── procurement/ProcurementService.ts
│   ├── suppliers/SupplierService.ts
│   ├── workforce/WorkforceService.ts
│   ├── assets/AssetService.ts
│   ├── events/OperationalEventService.ts
│   └── publication/OperationalPublicationService.ts
└── tests/
```

Package name: `@infinicus/business-operations-runtime`.

If an equivalent canonical runtime already exists, extend it instead of
creating a duplicate package.

## 7. DA → BO intake runtime

Consume the existing `dal-to-bo` / DA → BO contract.

Required behavior:

- validate supported contract/package versions;
- validate tenant/workspace/business scope;
- preserve quality/reliability, provenance, consent references, warnings and limitations;
- enforce idempotency;
- preserve correlation/causation;
- fail closed on unsupported record types;
- never silently discard rejected records;
- never mutate the source DA package;
- persist processing outcome using existing architecture where possible;
- acknowledge or reject through canonical handoff semantics.

## 8. Intake mapper registry

Use a deterministic, versioned registry.

Each mapper must declare:
- record type;
- version;
- input validation;
- deterministic mapping to explicit operational commands.

Unknown record types fail closed.

## 9. Operational commands

Internal writes must be expressed through explicit commands, not arbitrary
repository access. Commands must carry tenant, workspace, business,
correlation, causation, source, provenance, idempotency, actor and occurrence
time.

Representative commands:
- RecordInventoryMovement
- RegisterSupplier
- RecordGoodsReceipt
- RecordProcurementStateChange
- RecordWorkforceEvent
- RecordAssetStateChange
- RecordOperationalFact

## 10. Inventory runtime

Use existing canonical inventory items/warehouses and BO balance/movement
persistence.

Inventory mutations must be auditable. Reconcile direct
`InventoryBalanceRepository.adjustQuantity()` with canonical inventory
movement records and `bo.inventory.movement_recorded` so quantity cannot drift
without evidence.

Do not implement inventory accounting or COGS.

## 11. Procurement runtime

Use existing purchase-order/line-item/receipt persistence.

Guard lifecycle transitions. Reconcile generic status mutation against actual
database constraints and allowed transitions.

Do not implement AP accounting or journals.

## 12. Supplier runtime

Use canonical supplier identity/reference and existing supplier
agreement/performance persistence.

Do not create supplier accounting balances.

## 13. Workforce runtime

Use canonical employees and existing assignment/schedule/task/workflow
persistence.

Do not recreate organization/company/department/employee masters.

## 14. Asset runtime

Use existing booking, maintenance and inspection persistence.

Do not implement depreciation or asset accounting.

## 15. Commerce compatibility

Preserve existing products, order and register-session APIs. Do not perform a
destructive table move or public route rename.

Classify those capabilities as long-term COMMERCE ownership and use adapters or
service boundaries where needed.

BUILD-32 is not a full POS build.

## 16. Events

Reuse the existing event-contract/outbox backbone.

Priority:

```text
REUSE > EXTEND > NEW
```

Do not create a second event bus.

`business_operations.business_events` remains a compatibility operational
fact ledger. BUILD-33 is reserved for canonical cross-domain event architecture.

## 17. BO → BI publication

Reuse:
- `packages/handoff-contracts/src/bo-to-bi.ts`
- `business_operations.bo_publication_packages`
- `business_operations.bo_handoff_records`

Preserve lineage, correlation, idempotency, package state,
acknowledgement/rejection and schema version.

BO packages contain operational facts/references, not BI conclusions.

## 18. API

Create or extend controlled Business Operations routes using existing Fastify
conventions.

All mutating endpoints must retain:
- authentication;
- tenant context;
- business ownership verification;
- permission checks;
- active subscription enforcement;
- idempotency;
- schema validation;
- bounded payloads;
- audit;
- correlation IDs;
- controlled errors.

Do not break existing public endpoints.

## 19. Security and tenancy

Every persistent business operation must be tenant/workspace scoped and
business scoped where applicable.

Client-supplied business IDs are not authorization.

No raw secrets in runtime payloads or provenance.

No dynamic SQL derived from untrusted record keys.

No arbitrary event-type injection.

## 20. Migrations

Default expectation: no new migration.

Only add a migration if reconciliation proves current persistence cannot
satisfy a frozen BUILD-32 requirement.

If required, the next migration is allocated after the actual current highest
migration. The audited baseline is `0170`; never assume it if the branch has
advanced.

Never modify 0001–0170.

## 21. High-risk checks

Inspect and resolve only if verified:

1. PurchaseOrderRepository lifecycle guard weaknesses.
2. InventoryBalanceRepository direct balance adjustment versus movement audit.
3. OrderRepository route-business ownership and replay safety.
4. Dual product/catalog representation.
5. Register-session Commerce/Finance ownership boundary.
6. DA → BO contract exists but production BO consumer may be missing.
7. BO → BI contract exists and must not be duplicated.

## 22. Tests

Required:
- mapper/command/service unit tests;
- DA → BO integration;
- BO → BI publication integration;
- tenant isolation;
- workspace isolation;
- business isolation;
- idempotency replay and mismatch;
- state-transition rejection;
- unsupported-record rejection;
- outbox atomicity;
- RLS;
- API auth/permission/subscription/schema/error/correlation tests;
- affected package regression;
- workspace lint;
- workspace typecheck;
- workspace build;
- full repository regression where infrastructure permits.

Never claim green without current command evidence.

## 23. Completion criteria

BUILD-32 completes only when:
1. reconciliation report exists;
2. ownership map exists;
3. runtime package/service boundary exists;
4. DA → BO runtime consumption is governed;
5. supported records map deterministically;
6. tenancy isolation is proven;
7. mutations are idempotent;
8. events are transactional;
9. BO → BI uses the canonical contract;
10. existing BO persistence remains compatible;
11. no frozen migration is modified;
12. existing public API compatibility is preserved;
13. required tests pass;
14. completion report exists;
15. queue state is updated;
16. changes are committed/pushed;
17. implementation stops before BUILD-33.

## 24. Out of scope

- full POS replacement;
- full COMMERCE runtime;
- general ledger/double-entry accounting;
- AP/AR/banking/financial statements;
- payroll accounting;
- COGS accounting;
- universal Business Event Ledger;
- Digital Twin rewrite;
- Simulation rewrite;
- ADI rewrite;
- browser architecture rewrite.

## 25. Completion report

Create:

`.claude/state/reports/BUILD-32-BUSINESS-OPERATIONS-RUNTIME-completion.md`

Include exact files, migrations, tests/results, ownership decisions, security
findings, defects found/fixed, deferred items, remaining risks and next-build
recommendation.

## 26. Stop rule

After BUILD-32 validation and queue completion, stop. BUILD-33 is not
automatically authorized.
