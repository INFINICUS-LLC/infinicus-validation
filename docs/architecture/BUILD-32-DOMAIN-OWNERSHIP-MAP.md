# BUILD-32 — DOMAIN OWNERSHIP MAP

Status: frozen architecture map

## Locked top-level domains

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

Cross-cutting platform infrastructure is not a ninth business domain.

## EXPERIENCE

Canonical responsibilities:
- Owner experience
- Manager experience
- Accountant experience
- AI Copilot experience

BUILD-32 impact: none beyond exposing safe Operations capabilities to future
experience surfaces.

## BUSINESS ADMINISTRATION

Canonical responsibilities:
- Organization
- Companies
- Branches
- Departments
- Employees
- Permissions

Current compatibility:
- BO department responsibilities
- BO role assignments
- canonical `platform.employees`

BUILD-32 rule: preserve current data; do not recreate master hierarchy.
Dedicated administration runtime is later work.

## COMMERCE

Canonical responsibilities:
- POS
- Orders
- Payments
- Customers
- Refunds

Current compatibility surfaces:
- `platform.orders`
- `platform.customers`
- `platform.payments`
- BO order line items/events
- BO products/catalog
- BO register sessions
- quotations/customer pipeline where applicable

BUILD-32 rule: preserve APIs and persistence; use adapters; do not expand
Commerce scope.

## OPERATIONS

Canonical BUILD-32 ownership:

### Inventory
- inventory balances
- inventory movements
- warehouse operational state
- reorder signals
- stock receipts/transfers/adjustments

### Procurement
- purchase-order operational lifecycle
- purchase-order line items
- purchase receipts
- goods receipt state
- procurement workflow

### Suppliers
- supplier operational references
- supplier agreements
- supplier performance

### Workforce
- employee assignments
- work schedules
- tasks
- task assignments
- workflow instances
- operational capacity/state

### Assets
- resource bookings where operational
- maintenance schedules
- maintenance records
- asset inspections
- operational asset availability/state

Other BO concepts such as fulfilment, operational incidents and operational
performance remain compatible supporting Operations capabilities unless a
later frozen build assigns them more narrowly.

## FINANCE

Canonical responsibilities:
- Transaction Engine
- Accounting Ledger
- Accounts Payable
- Accounts Receivable
- Banking
- Financial Statements

Current compatibility references:
- invoices
- payments
- credit notes
- expense claims
- procurement monetary values
- register cash reconciliation

BUILD-32 rule:
Operations may record operational facts and monetary references, but must not
create accounting journal truth, AP/AR balances, bank reconciliation or
financial statements.

## DATA

Canonical responsibilities:
- Acquisition
- Event Ledger
- Normalization
- Canonical Business Model

Current:
- BUILD-31 Data Acquisition Runtime
- DAL/DA → BO handoff
- existing compatibility operational fact ledger

BUILD-32 rule:
consume governed DA output. Do not redesign Data Acquisition.
The future canonical cross-domain Event Ledger is reserved for BUILD-33.

## INTELLIGENCE

Canonical responsibilities:
- Business Intelligence
- Forecasting
- Digital Twin
- Simulation
- AI Decision Intelligence

BUILD-32 rule:
publish governed operational packages through the existing BO → BI contract.
Do not write directly into intelligence-owned persistence.

## CONTROL LOOP

Canonical responsibilities:
- Approval
- Action
- Outcome Monitoring
- Continuous Learning

BUILD-32 rule:
Operations may expose facts/events consumed by the control loop but may not
bypass approval/action/outcome/learning ownership.

## CROSS-CUTTING INFRASTRUCTURE

Not a business domain:
- authentication
- authorization
- tenancy/workspace context
- RLS
- idempotency
- audit
- observability
- billing entitlement
- configuration
- secrets
- deployment
- incident response infrastructure
- API transport

BUILD-32 must reuse these existing systems.

## Ownership matrix

| Current concept | Canonical owner | BUILD-32 treatment |
|---|---|---|
| platform.orders | COMMERCE | preserve, adapter only |
| BO order line items/events | COMMERCE compatibility | preserve |
| BO products | COMMERCE compatibility | reconcile/adapt |
| BO register sessions | COMMERCE | preserve/adapt |
| platform.payments | COMMERCE transaction / FINANCE accounting consumer | preserve |
| platform.customers | COMMERCE | preserve |
| platform.suppliers | OPERATIONS reference | preserve |
| BO supplier agreements/performance | OPERATIONS | runtime-owned |
| platform.inventory_items | OPERATIONS canonical reference | preserve |
| platform.warehouses | OPERATIONS canonical reference | preserve |
| BO inventory balances/movements | OPERATIONS | runtime-owned |
| BO purchase orders/receipts | OPERATIONS | runtime-owned |
| platform.employees | BUSINESS ADMINISTRATION master | preserve |
| BO assignments/schedules/tasks | OPERATIONS | runtime-owned |
| BO maintenance/inspections | OPERATIONS | runtime-owned |
| invoices/credit notes/accounting balances | FINANCE | no new finance truth |
| DA publication package | DATA | consume, never mutate |
| BO publication package | OPERATIONS producer / INTELLIGENCE consumer boundary | runtime-owned publication |
| business_events | compatibility operational fact ledger | preserve; not universal |
| BI/DT/SIM/ADI | INTELLIGENCE | handoff only |
| ABA/OM/CL | CONTROL LOOP | no direct writes |

## Enforcement rule

A new capability must be placed into one of the eight business domains or
identified as cross-cutting infrastructure. BUILD-32 may not create a ninth
business domain.
