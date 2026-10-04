# BUILD-32+ DEVELOPMENT OWNERSHIP

Status: Active architecture control
Branch: `build-32-business-operations-runtime`

## Ownership split

### BUILD-32 onward
Owned by the BUILD-32+ architecture workstream.

Responsibilities:
- architecture governance
- build specifications
- repository reconciliation
- domain ownership
- implementation sequencing
- migration strategy
- security/tenancy guardrails
- test and acceptance gates

### BUILD-01 through BUILD-31
Claude may close verified legacy gaps and regressions only.

Claude must not:
- redesign BUILD-32+
- create a ninth business domain
- rewrite frozen migrations
- change BUILD-32+ ownership boundaries
- start BUILD-33+ without an authoritative frozen specification

## Locked business architecture

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

BUILD-32 owns the OPERATIONS runtime:

```text
OPERATIONS
├── Inventory
├── Procurement
├── Suppliers
├── Workforce
└── Assets
```

Commerce and Finance remain separate canonical domains even where legacy Business Operations persistence contains compatibility records.

## Branch policy

No BUILD-32+ feature development on `main`.

Legacy remediation and BUILD-32+ implementation must use separate branches. A legacy fix needed by BUILD-32+ must be reviewed and merged to main before being consumed by this branch.

## Architecture principle

Preserve and compose working systems. Do not replace them merely to improve naming or conceptual purity.
