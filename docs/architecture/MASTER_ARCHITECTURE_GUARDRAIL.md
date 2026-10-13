# INFINICUS — MASTER ARCHITECTURE GUARDRAIL (v1.0, LOCKED)

> **Storage note (not part of the owner's text).** This file stores the owner-provided Master Architecture Guardrail v1.0 verbatim, below the second horizontal rule. The owner's wording and section structure are unchanged; nothing has been rewritten, simplified or weakened. Stored by Claude on 2026-10-13 at the owner's instruction (completion gap assessment block). Only the owner may amend it (Section XXV).
>
> **Authority hierarchy (restated from Section XXVI):**
> Master Architecture Guardrail → locked layer specifications → cross-layer standards → domain contracts → build specifications → implementation → test fixture → convenience / developer assumption.
>
> **Where existing repository documents conflict with this guardrail,** the conflict is not resolved here. It is recorded in `docs/architecture/reconciliation/COMPLETION_GAP_ASSESSMENT.md` (section 8, "Recorded conflicts and ambiguities") for an owner ruling. Locked layer specifications under `docs/architecture/locked/` were not edited.
>
> Related existing documents: `docs/architecture/BUILD-33-ARCHITECTURE-GUARDRAIL-RECONCILIATION-v1.1.md` (earlier guardrail reconciliation) and `docs/architecture/locked/INFINICUS_MASTER_ARCHITECTURE_MANIFEST_CONTRACT_MATRIX_v1.0.md`.

---

---

INFINICUS — MASTER ARCHITECTURE GUARDRAIL
LOCKED TARGET ARCHITECTURE + PROGRAMME COMPLETION BOUNDARY
VERSION 1.0

STATUS:
LOCKED

AUTHORITY:
OWNER-APPROVED MASTER ARCHITECTURE

PURPOSE

This document defines:

1. what INFINICUS is;
2. which layer owns each kind of truth;
3. how decisions move through the system;
4. what is permitted to execute;
5. what constitutes completion;
6. what is explicitly outside the current build;
7. when development MUST STOP.

This document is not a roadmap suggestion.

It is the architecture boundary for the current INFINICUS programme.

Lower-level specifications, PRs, migrations, implementation choices, tests,
Claude instructions, or developer convenience MUST NOT override it.

======================================================================
I. PRODUCT TARGET
======================================================================

INFINICUS is a governed business intelligence and autonomous decision platform.

Its target operating cycle is:

REAL BUSINESS DATA
    ↓
DATA ACQUISITION
    ↓
BUSINESS OPERATIONS TRUTH
    ↓
BUSINESS INTELLIGENCE
    ↓
BUSINESS DIGITAL TWIN
    ↓
SIMULATION
    ↓
AI DECISION INTELLIGENCE
    ↓
APPROVED BUSINESS ACTION
    ↓
BUSINESS OPERATIONS EXECUTION
    ↓
OUTCOME MEASUREMENT
    ↓
CONTINUOUS LEARNING

The objective of the current programme is NOT:

"keep adding business features."

The objective is:

Build one complete, governed, auditable, fail-closed decision lifecycle
from real data through recommendation, authorization, execution,
verification and governed learning readiness.

Once that lifecycle is complete and production-ready for the first
supported action type, the current architecture programme is COMPLETE.

======================================================================
II. THE NINE LOCKED DECISION-LIFECYCLE LAYERS
======================================================================

LAYER 1 — DAL
DATA ACQUISITION LAYER

Purpose:
Acquire, normalize, validate and prepare source data.

Owns:
- source connectors;
- imports;
- ingestion;
- normalization;
- provenance;
- raw-to-canonical preparation.

Does NOT own:
- operational business truth;
- business decisions;
- recommendations;
- authorization;
- execution.

Canonical output:
Prepared governed data for downstream operational systems.

---------------------------------------------------------------------

LAYER 2 — BO
BUSINESS OPERATIONS

Purpose:
Hold authoritative operational business state and perform approved
operational mutations.

Owns:
- operational source of truth;
- inventory;
- transactions;
- operational records;
- execution of AuthorizedActionPackages;
- execution receipts;
- execution evidence;
- operational refusal/failure facts.

BO is the ONLY layer permitted to perform operational mutations.

Does NOT own:
- recommendation generation;
- authorization decisions;
- outcome effectiveness conclusions;
- learning conclusions.

---------------------------------------------------------------------

LAYER 3 — BI
BUSINESS INTELLIGENCE

Purpose:
Convert operational truth into analytical evidence.

Owns:
- analytical evidence;
- reports;
- historical aggregation;
- descriptive metrics;
- business intelligence facts.

Does NOT execute operations.

---------------------------------------------------------------------

LAYER 4 — BDT
BUSINESS DIGITAL TWIN

Purpose:
Represent the modeled current state of the business.

Owns:
- modeled present-state representation;
- derived state required for decision modeling;
- governed twin state.

Does NOT:
- become a second operational source of truth;
- mutate real operations.

BO remains operational truth.

---------------------------------------------------------------------

LAYER 5 — SIM
SIMULATION

Purpose:
Simulate alternative business actions before commitment.

Owns:
- scenarios;
- modeled outcomes;
- comparative simulations;
- simulation evidence.

SIM is:
"Simulate Before You Invest."

Does NOT:
- authorize actions;
- execute actions;
- mutate BO;
- claim that simulated outcomes actually occurred.

---------------------------------------------------------------------

LAYER 6 — ADI
AI DECISION INTELLIGENCE

Purpose:
Produce governed recommendations.

Owns:
- recommended action;
- proposed parameters;
- reasoning/evidence linkage;
- recommendation confidence;
- decision proposal.

ADI may recommend.

ADI may NEVER execute.

ADI may NEVER directly mutate Business Operations.

---------------------------------------------------------------------

LAYER 7 — ABA
APPROVED BUSINESS ACTION

Purpose:
Govern authorization.

Owns:
- approval decision;
- approval authority;
- modification of recommended parameters;
- final authorized parameters;
- approval lineage;
- AuthorizedActionPackage;
- authorization lifecycle:
  ISSUED
  REVOKED
  SUPERSEDED
  EXPIRED
  CONSUMED mirror.

ABA authorizes.

ABA does NOT execute.

ABA must never directly mutate BO operational state.

---------------------------------------------------------------------

LAYER 8 — OM
OUTCOME MEASUREMENT

Purpose:
Verify what happened after execution.

Owns:
- execution verification;
- post-action observation;
- verified outcome evidence;
- outcome state;
- measurement windows;
- governed attribution when supported.

OM must distinguish:

EXECUTION VERIFIED

from:

OUTCOME VERIFIED.

A successful BO command is NOT proof that the business outcome improved.

---------------------------------------------------------------------

LAYER 9 — CL
CONTINUOUS LEARNING

Purpose:
Learn only from governed verified outcomes.

Owns:
- governed learning inputs;
- versioned learning outputs;
- learning lineage;
- model/policy improvement evidence.

CL may consume only governed OM-verified outcomes.

CL MUST NOT learn directly from:

- ADI recommendations;
- ABA approvals;
- BO execution;
- EXECUTION_VERIFIED;
- OUTCOME_PENDING;
- unverified results.

CL fails CLOSED.

======================================================================
III. THE EIGHT PLATFORM DOMAINS
======================================================================

The lifecycle layers above and platform domains below are independent views.

The platform domains are:

1. EXPERIENCE
2. BUSINESS ADMINISTRATION
3. COMMERCE
4. OPERATIONS
5. FINANCE
6. DATA
7. INTELLIGENCE
8. CONTROL LOOP

Cross-cutting ownership is locked as follows:

BUSINESS ADMINISTRATION
- authentication;
- authorization;
- RBAC;
- tenancy;
- memberships;
- platform administration;
- platform subscription/billing administration;
- operational administration;
- incident administration.

DATA
- events;
- event contracts;
- outbox;
- transport;
- handoff infrastructure;
- ingestion infrastructure.

INTELLIGENCE
- AI/LLM client infrastructure;
- models;
- inference services used by intelligence layers.

CONTROL LOOP
- outcome feedback;
- governed learning;
- learning/version lifecycle.

======================================================================
IV. SOURCE-OF-TRUTH RULES
======================================================================

There MUST be exactly one authoritative owner for every business fact.

Locked truth hierarchy:

DAL
prepared source data

BO
operational business truth

BI
analytical evidence

BDT
modeled current state

SIM
scenario outcomes

ADI
recommendations

ABA
authorization truth

BO
execution truth

OM
verified post-action outcome evidence

CL
governed learning truth

No layer may silently become a second source of truth for another layer.

======================================================================
V. LOCKED EXECUTION FLOW
======================================================================

The only permitted autonomous action flow is:

ADI recommendation
    ↓
ABA governance
    ↓
AuthorizedActionPackage
    ↓
BO intake
    ↓
BO receipt
    ↓
single-use BO claim
    ↓
fresh ABA authority check
    ↓
BO execution
    ↓
ExecutionEvidence
    ↓
operations.action.executed event
    ↓
OM verification
    ↓
governed outcome
    ↓
CL eligibility only after verified outcome

No alternative execution path is permitted.

======================================================================
VI. AUTHORIZED ACTION PACKAGE
======================================================================

AuthorizedActionPackage is an immutable, versioned handoff contract.

It must identify:

- package ID;
- package version;
- action identity;
- action type/version;
- target;
- tenant/workspace/business scope;
- final effective parameters;
- approval lineage;
- accountable owner;
- governing constraints;
- execution window;
- validity;
- required evidence;
- authorization provenance;
- integrity digest.

Package integrity uses canonical serialization + SHA-256 or repository
approved equivalent.

Digest integrity does NOT replace authorization.

======================================================================
VII. AUTHORITY RULE
======================================================================

Authority must be valid:

1. when an action is approved;
2. when the AuthorizedActionPackage is issued;
3. immediately before actual BO mutation.

A historical approval is not permanent execution authority.

A BO claim is not execution authority.

A package receipt is not execution authority.

Capability support is not execution authority.

Activation is not execution authority.

Subscription presence is not execution authority.

Every actual mutation remains subject to current ABA authority.

======================================================================
VIII. ACTIVATION MODEL
======================================================================

Production execution must fail CLOSED.

Execution requires ALL applicable gates:

- supported action type;
- valid package;
- valid BO receipt;
- single-use BO claim;
- governed activation;
- valid subscriptions;
- kill switch not engaged;
- current authority;
- fresh status;
- execution window;
- preconditions;
- baseline protection;
- supported target;
- operational constraints.

No activation may be inferred from:

- package existence;
- approval existence;
- business ownership;
- browser state;
- environment variables alone;
- capability registration alone.

======================================================================
IX. FIRST SUPPORTED ACTION TYPE
======================================================================

The current architecture programme is scoped to prove the lifecycle using:

inventory_reorder_policy_update@1

Target kind:

inventory_item

Authorized parameters:

- reorderPoint
- reorderQuantity

Both must be non-negative.

No additional autonomous action type is required to complete the current
architecture programme.

Additional action types belong to a later product-expansion programme.

======================================================================
X. FIRST ACTION EXECUTION INVARIANTS
======================================================================

For inventory_reorder_policy_update@1:

BO must:

- lock the target;
- revalidate current ABA authority;
- validate package identity/version/digest;
- validate scope;
- validate action capability;
- validate governed activation;
- validate execution window;
- validate preconditions;
- use authoritative baseline evidence;
- compare live state against approved baseline;
- refuse stale baseline;
- use the single BO writer;
- record APPLIED or NO_CHANGE correctly;
- record terminal execution evidence;
- produce the executed event transactionally.

A changed baseline must never be silently overwritten.

======================================================================
XI. OUTCOME RULE
======================================================================

The system must never confuse:

"the action executed"

with:

"the action worked."

BO may establish:

SUCCEEDED
REFUSED
FAILED

and:

APPLIED
NO_CHANGE
NOT_APPLICABLE

OM establishes effectiveness.

Until a governed measurement window, baseline and attribution method exist:

OM may use states such as:

EXECUTION_VERIFIED
OUTCOME_PENDING
OUTCOME_INCONCLUSIVE

It must not fabricate:

OUTCOME_VERIFIED

without authoritative supporting evidence.

======================================================================
XII. CONTINUOUS LEARNING RULE
======================================================================

CL is NOT required to become a self-modifying autonomous AI system in the
current programme.

Current target:

prove the governed learning boundary.

Required:

- CL cannot consume raw execution as success;
- CL cannot consume OUTCOME_PENDING;
- CL cannot consume unverified observations;
- learningEligibility must fail closed;
- lineage must exist for future governed learning.

Full adaptive learning is a later programme.

======================================================================
XIII. IDENTITY AND TENANCY
======================================================================

All authoritative actions must be bound to canonical INFINICUS-controlled
identity and tenancy.

Provider IDs are not public business identifiers.

Browser supplied IDs must not create authority.

Owner authority must originate from authoritative server-side,
business-specific ownership relationships.

created_by is not ownership proof.

No owner backfill may be performed without explicit owner authorization.

======================================================================
XIV. RBAC
======================================================================

Every privileged action requires:

- authenticated identity;
- canonical membership;
- tenant/workspace/business scope;
- required permission;
- audit record;
- current authority.

No route may invent authority because the caller created an object.

Higher-risk operations may later require maker/checker or step-up controls.

The current programme does not require arbitrary expansion of approval models
unless demanded by the first supported action.

======================================================================
XV. EVENT ARCHITECTURE
======================================================================

Events and handoffs are DATA-owned infrastructure.

Use the existing canonical outbox/event infrastructure.

Do not create parallel event systems.

Critical events must be:

- versioned;
- deterministic where idempotency requires;
- scoped;
- auditable;
- idempotent;
- transport-safe.

An operational transaction must not commit while its required durable event
can silently disappear.

======================================================================
XVI. IDEMPOTENCY
======================================================================

Idempotency is a platform invariant.

Required at:

- authorization mutation boundaries;
- package issuance;
- BO intake;
- claim;
- execution;
- event publication;
- OM verification;
- recovery;
- externally retried mutations.

Idempotency mechanisms may live in DATA/infrastructure,
but each mutation owner must enforce them.

======================================================================
XVII. RETRY / RECOVERY
======================================================================

A claim must never remain permanently stranded because a transport attempt
ended after claim creation.

Recovery must:

- use the existing governed transport/recovery mechanism;
- remain tenant scoped;
- preserve current authority checks;
- never create a second executor;
- never create a second retry policy;
- never use cross-tenant BYPASSRLS scanning unless separately authorized.

A recovery mechanism that merely moves the stranded-claim failure into a
second dead-letter mechanism is NOT complete.

======================================================================
XVIII. STACK AUTHORITY
======================================================================

Target authoritative implementation:

Stack B
infinicus-platform
PostgreSQL

Legacy/Stack A systems may remain temporarily for compatibility,
migration or client continuity.

They must not remain independent competing sources of truth after controlled
cutover.

Do not abruptly retire Stack A.

Removal requires:

1. replacement exists;
2. dependents migrated;
3. source-of-truth migration proven;
4. validation complete;
5. rollback available;
6. explicit retirement authorization.

======================================================================
XIX. DATABASE RULES
======================================================================

PostgreSQL is the target authoritative database.

Rules:

- migrations are immutable once merged;
- new schema changes use new migrations;
- migration numbers are allocated from current main;
- RLS is fail closed where required;
- append-only evidence/audit tables remain append-only;
- database hard invariants should protect critical execution facts;
- live migration state must never be assumed from repository migration head.

No live migration without explicit owner authorization.

======================================================================
XX. AUDIT
======================================================================

Governance and execution changes must be auditable.

Audit should capture where applicable:

- actor;
- identity;
- permission;
- scope;
- target;
- action;
- timestamp;
- correlation;
- reason;
- result.

Audit evidence must not be mutable through ordinary application paths.

======================================================================
XXI. USER EXPERIENCE MODES
======================================================================

Guided and Professional experiences may differ in presentation.

They must NOT create:

- separate calculation engines;
- separate business truth;
- separate permission systems;
- separate simulation semantics;
- separate execution semantics.

They are presentation modes over the same governed architecture.

======================================================================
XXII. CURRENT PROGRAMME COMPLETION TARGET
======================================================================

THE CURRENT INFINICUS ARCHITECTURE PROGRAMME IS COMPLETE WHEN ALL OF THE
FOLLOWING ARE TRUE:

A. DATA ACQUISITION
- canonical data can enter the system;
- provenance and normalization are governed;
- required data for the first action is available.

B. BUSINESS OPERATIONS
- canonical operational truth exists;
- first supported action has one authoritative writer;
- BO execution is transactionally safe.

C. BI / BDT / SIM
- required evidence and modeled state for the first action exist;
- simulation evidence required by governance can be produced and referenced.

D. ADI
- recommendation for the first action can be produced in governed form;
- recommendation cannot execute directly.

E. ABA
- recommendation can be reviewed/approved;
- final parameters are governed;
- AuthorizedActionPackage is sealed/versioned;
- authority can be revoked/expired/superseded;
- current authority can be checked by BO.

F. BO EXECUTION
- intake;
- receipt;
- single-use claim;
- activation;
- fresh authority;
- target lock;
- baseline CAS;
- execution;
- evidence;
- retry/recovery;
all work end-to-end.

G. EVENTS
- authorization and executed-event handoffs are durable and idempotent.

H. OM
- execution evidence is independently verified;
- execution verification is separate from outcome effectiveness;
- pending/inconclusive outcomes remain fail closed.

I. CL
- no unverified result can enter learning;
- governed learning boundary is proven.

J. SECURITY / TENANCY
- authorization and tenant isolation are validated;
- no browser-derived authority;
- no owner backfill;
- RLS/permission boundaries pass.

K. DATABASE
- repository migrations validated;
- live migration delta explicitly reviewed;
- migrations can be applied through a controlled runbook;
- rollback/backup procedure exists.

L. OPERATIONS
- backup/restore validation exists;
- observability exists for execution failures and stranded work;
- deployment runbook exists;
- production remains closed until owner activation.

M. END-TO-END
At least one real supported action type:

inventory_reorder_policy_update@1

must successfully prove:

data
-> evidence
-> modeled decision
-> simulation
-> recommendation
-> approval
-> package
-> claim
-> execution
-> execution evidence
-> OM verification

with negative-path tests proving fail-closed behavior.

======================================================================
XXIII. HARD STOP — WHAT IS NOT REQUIRED BEFORE COMPLETION
======================================================================

The following are NOT required to declare the current architecture programme
complete:

- second or third autonomous action types;
- full autonomous Continuous Learning;
- automatic model retraining;
- arbitrary workflow builder;
- every possible ERP/POS connector;
- every possible business vertical;
- multi-country tax engine;
- broad enterprise feature expansion;
- unlimited dashboards;
- generalized automation marketplace;
- new UI redesigns unrelated to first lifecycle;
- replacement of every legacy endpoint;
- performance optimization without measured need;
- speculative abstractions;
- refactors merely for style;
- features not necessary to prove the locked lifecycle.

These require a NEW owner-authorized programme.

======================================================================
XXIV. DEFINITION OF DONE
======================================================================

When Section XXII is satisfied:

STOP FEATURE DEVELOPMENT.

The next phase is only:

1. final architecture audit;
2. security/readiness audit;
3. live database reconciliation;
4. backup verification;
5. controlled migration;
6. controlled deployment;
7. explicit owner production activation.

Do not continue adding capabilities because there are opportunities to improve.

After architecture completion, any additional product capability requires a
new approved BUILD programme.

======================================================================
XXV. CHANGE CONTROL
======================================================================

This architecture is LOCKED.

If implementation reveals a conflict:

DO NOT silently adapt the architecture.

STOP and report:

ARCHITECTURE CONFLICT

Include:

- conflicting specification;
- implementation evidence;
- affected layer/domain;
- source-of-truth impact;
- security/authorization impact;
- alternatives;
- recommended amendment.

Only the owner may authorize an architecture amendment.

======================================================================
XXVI. AUTHORITY HIERARCHY
======================================================================

When sources disagree, authority order is:

1. MASTER ARCHITECTURE GUARDRAIL
2. LOCKED LAYER SPECIFICATION
3. CROSS-LAYER STANDARD
4. DOMAIN CONTRACT
5. BUILD SPECIFICATION
6. IMPLEMENTATION
7. TEST FIXTURE
8. CONVENIENCE / DEVELOPER ASSUMPTION

A lower level may never silently override a higher one.

======================================================================
XXVII. CLAUDE WORK RULE
======================================================================

Before every BUILD, migration, refactor or implementation:

Claude must answer:

1. Which locked layer owns this work?
2. Which source of truth does it touch?
3. Does it change an existing authority boundary?
4. Does it create another writer?
5. Does it create another execution path?
6. Is it necessary for Section XXII completion?
7. Is it explicitly outside Section XXIII?
8. What exact completion criterion does this work close?

If question 6 cannot be answered clearly:

DO NOT BUILD IT.

If work falls only into Section XXIII:

STOP.
It belongs to a future programme.

======================================================================
XXVIII. REQUIRED COMPLETION REPORT
======================================================================

After every block return:

PROJECT:
BLOCK:
ARCHITECTURE LAYER:
COMPLETION CRITERION CLOSED:

1. WHAT WAS DONE
2. WHY IT WAS REQUIRED
3. FILES / MIGRATIONS
4. SOURCE-OF-TRUTH IMPACT
5. AUTHORITY IMPACT
6. TESTS ACTUALLY RUN
7. CI STATUS
8. REMAINING GAP FOR THIS CRITERION
9. ARCHITECTURE CONFLICTS
10. DELIBERATELY NOT DONE

Then:

Current Module:
Completed:
Remaining:
Next:
Estimated Blocks To Architecture Completion:

STOP.

Do not automatically begin the next block.

======================================================================
FINAL OWNER RULE
======================================================================

INFINICUS is not complete when there is nothing else that could be built.

INFINICUS is complete when the locked governed lifecycle is proven,
production-ready, auditable, recoverable, secure and deployable for the first
supported autonomous action.

At that point:

STOP BUILDING THE ARCHITECTURE.

Everything else becomes a new product-expansion programme requiring separate
owner authorization.
