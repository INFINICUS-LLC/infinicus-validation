# INFINICUS PLATFORM — ROOT CLAUDE.md

## 1. Purpose

This repository is the master monorepo for the INFINICUS platform.

INFINICUS is a modular business operating and decision-intelligence platform composed of nine major layers:

1. Data Acquisition
2. Business Operations
3. Business Intelligence
4. Business Digital Twin
5. Simulation
6. AI Decision Intelligence
7. Approved Business Action
8. Outcome Monitoring
9. Continuous Learning

Claude must treat this repository as one coordinated platform, not as a collection of unrelated projects.

---

## 2. Repository Structure

Use this structure exactly:

```text
infinicus-platform/
├── apps/
│   ├── web/
│   ├── admin/
│   └── api/
├── layers/
│   ├── data-acquisition/
│   ├── business-operations/
│   ├── business-intelligence/
│   ├── business-digital-twin/
│   ├── simulation/
│   ├── ai-decision-intelligence/
│   ├── approved-business-action/
│   ├── outcome-monitoring/
│   └── continuous-learning/
├── packages/
│   ├── shared-types/
│   ├── database/
│   ├── event-contracts/
│   ├── handoff-contracts/
│   ├── authentication/
│   ├── authorization/
│   ├── configuration/
│   ├── observability/
│   └── testing/
├── infrastructure/
│   ├── database/
│   ├── deployment/
│   ├── monitoring/
│   └── backups/
├── docs/
├── tests/
├── package.json
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json
└── CLAUDE.md
```

Do not rename these root folders unless explicitly instructed.

---

## 3. Immediate Objective

The first objective is to create the monorepo foundation before expanding the frontend.

Work in this order:

1. Create the root workspace.
2. Create all required folders.
3. Create root configuration files.
4. Create shared package placeholders.
5. Create layer placeholders.
6. Create the architecture manifest.
7. Create validation scripts.
8. Verify the monorepo structure.
9. Stop and report before importing block code.

Do not start building application features yet.

---

## 4. Technical Standards

Use:

- TypeScript
- Node.js
- pnpm workspaces
- Turborepo
- PostgreSQL-compatible database architecture
- Zod for validation
- Vitest for testing
- ESLint
- Prettier

Prefer framework-neutral packages in `layers/` and `packages/`.

Frontend applications may use Next.js only if instructed later.

The API application may use Fastify, NestJS, or another framework only after the base architecture is approved.

---

## 5. Package Boundaries

### apps/

Applications may depend on packages and layers.

Applications must not contain core business logic that belongs in a layer or shared package.

### layers/

Each layer contains domain-specific business logic.

A layer may depend on:

- shared-types
- database
- event-contracts
- handoff-contracts
- authentication
- authorization
- configuration
- observability
- testing

A layer must not directly import another layer's internal files.

Cross-layer communication must use:

- event contracts
- handoff contracts
- public package exports

### packages/

Packages contain reusable platform capabilities.

Packages must not depend on applications.

Avoid circular dependencies.

---

## 6. Standard Block Structure

When importing or converting a block, use:

```text
block-name/
├── src/
│   ├── domain/
│   ├── application/
│   ├── infrastructure/
│   ├── contracts/
│   └── index.ts
├── tests/
├── package.json
├── tsconfig.json
└── README.md
```

Responsibilities:

- `domain/`: entities, value objects, domain rules
- `application/`: use cases, orchestration, services
- `infrastructure/`: persistence, adapters, external integrations
- `contracts/`: public inputs, outputs, events, handoffs
- `index.ts`: public exports only

Do not expose internal implementation files through cross-layer imports.

---

## 7. Canonical Shared Fields

Every persistent business record must support these fields where applicable:

```ts
type BaseRecord = {
  id: string;
  tenantId: string;
  workspaceId: string;
  businessId: string;
  status: string;
  version: number;
  sourceSystem: string;
  sourceRecordId?: string;
  correlationId: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  lineage: LineageEntry[];
};
```

Do not create incompatible alternatives inside separate layers.

---

## 8. Handoff Contract

All cross-layer handoffs must follow a shared envelope:

```ts
type LayerHandoff<TPayload> = {
  handoffId: string;
  sourceLayer: string;
  sourceBlock: string;
  targetLayer: string;
  targetBlock: string;
  payload: TPayload;
  correlationId: string;
  lineage: LineageEntry[];
  status: "ready" | "blocked" | "failed";
  createdAt: string;
};
```

Do not pass undocumented raw objects between layers.

---

## 9. Event Contract

All platform events must use:

```ts
type PlatformEvent<TPayload> = {
  eventId: string;
  eventType: string;
  eventVersion: string;
  tenantId: string;
  businessId: string;
  correlationId: string;
  causationId?: string;
  payload: TPayload;
  occurredAt: string;
  publishedAt: string;
};
```

Events must be versioned.

Event names must use lowercase dot notation.

Examples:

```text
da.data.published
bo.order.completed
bi.insight.generated
dt.state.updated
simulation.completed
adi.decision.generated
aba.action.approved
om.outcome.evaluated
cl.learning.published
```

---

## 10. Operational State Rule

Never treat planned work as completed.

Use distinct states where applicable:

```text
planned
authorized
executed
completed
failed
reversed
```

Executed and completed states must require execution evidence.

---

## 11. Database Rules

The future production database will be authoritative.

IndexedDB or browser storage may be used only for:

- offline cache
- temporary drafts
- local UI state
- development demonstrations

Do not use browser storage as the production source of truth.

Database work must include:

- migrations
- foreign keys
- indexes
- tenant isolation
- audit tables
- event storage
- file metadata
- backup and restoration procedures
- retention rules
- database tests

---

## 12. Security Rules

Do not commit:

- passwords
- API keys
- private tokens
- database credentials
- secret environment variables

Use environment-variable references and documented placeholders.

Credential records must store references, never raw secrets.

Tenant isolation must be enforced in every persistent query.

---

## 13. Token and Output Control

Work in small executable increments.

For each task:

1. Inspect existing files first.
2. State the exact files to create or modify.
3. Modify only the necessary files.
4. Run validation.
5. Report results.
6. Stop before the next major phase.

Do not:

- rewrite unrelated files
- generate large unused code blocks
- repeat entire files when a patch is sufficient
- rebuild working modules without a reason
- continue automatically into the next major milestone

When code is large, split it into small executable batches.

---

## 14. Validation Requirements

After each batch, run the relevant checks:

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

At the foundation stage, also verify:

```bash
pnpm workspace:validate
```

Do not claim success unless the command actually passes.

If a command fails:

1. identify the exact error;
2. fix the smallest relevant issue;
3. rerun the failed command;
4. report the real result.

---

## 15. First Task

Create only the monorepo foundation.

Required root files:

```text
package.json
pnpm-workspace.yaml
turbo.json
tsconfig.base.json
.gitignore
.env.example
README.md
CLAUDE.md
```

Required directories:

```text
apps/web
apps/admin
apps/api

layers/data-acquisition
layers/business-operations
layers/business-intelligence
layers/business-digital-twin
layers/simulation
layers/ai-decision-intelligence
layers/approved-business-action
layers/outcome-monitoring
layers/continuous-learning

packages/shared-types
packages/database
packages/event-contracts
packages/handoff-contracts
packages/authentication
packages/authorization
packages/configuration
packages/observability
packages/testing

infrastructure/database
infrastructure/deployment
infrastructure/monitoring
infrastructure/backups

docs
tests
scripts
```

Also create:

```text
docs/architecture-manifest.md
scripts/validate-workspace.mjs
```

The workspace validation script must confirm that every required directory and root file exists.

Do not import layer block code yet.

Do not build frontend pages yet.

Do not create the production database schema yet.

Stop after:

- creating the foundation;
- running workspace validation;
- reporting created files;
- reporting validation results.

---

## 16. Completion Report Format

At the end of the first task, report:

```text
Created:
- files
- directories

Validation:
- command
- result

Not started:
- block import
- database schema
- authentication
- event backbone
- frontend expansion

Next recommended task:
- import and inventory completed layer blocks
```

---

## 17. Standing Report Rule (locked by the owner)

After every build, implementation, deployment or assignment, report with a single copy-and-paste block. This rule applies from
the day it was locked and to every session; it is not optional and is not superseded by the task-specific formats above.

The report states, in this order:

1. what was done and the PR or commit reference (lead with the answer);
2. verification actually run, with real results (never claim a pass that was not run);
3. CI status, saying plainly when it is unconfirmed;
4. findings, stop conditions, and questions for the owner with a recommendation for each;
5. what was deliberately not done.

It always ends with this footer, then stops:

```text
Current Module:
Completed Blocks:
Remaining Blocks:
Next Recommended Block:
Estimated Remaining Blocks:
```

Standing conditions that go with the rule: Claude never merges or approves; work is delivered as a DRAFT pull request; no live
database, Cloudflare, DNS or secret change is made without explicit authorization; and Claude stops after each authorized block
instead of starting the next one.
