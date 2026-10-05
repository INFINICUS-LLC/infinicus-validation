# BUILD-33 — Architecture Guardrail Reconciliation / Specification Amendment v1.1

**Build:** BUILD-33 — Cross-Domain Business Event Architecture  
**Amends:** BUILD-33 Specification v1.0  
**Status:** FROZEN ARCHITECTURE AMENDMENT  
**Authority:** INFINICUS Master Architecture Guardrail v1.0  
**Issued:** 2026-10-05  
**Implementation status:** IN_PROGRESS — PAUSED AT ARCHITECTURE GATE

---

## 1. Purpose

This amendment reconciles BUILD-33 against the mandatory INFINICUS architecture
guardrail introduced after BUILD-33 v1.0 was frozen.

It is a compatible architecture-preserving amendment. It does not reassign any
domain or layer responsibility. It narrows and clarifies BUILD-33 so that event
infrastructure cannot become a competing source of business truth.

No BUILD-34 work is authorized by this amendment.

---

## 2. Mandatory dual-architecture validation

BUILD-33 must simultaneously preserve both architectural views.

### Platform-domain owner

Primary implementation owner:

```text
DATA → Event Infrastructure / Contracts / Lineage
```

Supporting domains:

```text
EXPERIENCE
BUSINESS ADMINISTRATION
COMMERCE
OPERATIONS
FINANCE
INTELLIGENCE
CONTROL LOOP
```

These supporting domains remain owners of their own private business state.

### Nine-layer lifecycle served

BUILD-33 supports, but does not replace:

```text
1. Data Acquisition
2. Business Operations
3. Business Intelligence
4. Business Digital Twin
5. Simulation
6. AI Decision Intelligence
7. Approved Business Action
8. Outcome Monitoring
9. Continuous Learning
```

The Event Ledger is infrastructure used by all nine layers. It is not a tenth
decision layer.

---

## 3. Required pre-build declaration

**FEATURE:** Cross-Domain Business Event Architecture  
**DOMAIN OWNER:** DATA  
**LAYER(S) SERVED:** All nine decision-lifecycle layers  
**SOURCE OF TRUTH:** Immutable event history, lineage and transport evidence only  
**INPUT CONTRACT:** Governed canonical Business Event envelope  
**OUTPUT CONTRACT:** Immutable canonical event record plus governed delivery evidence  
**EVENTS PRODUCED:** Event-infrastructure evidence only; no foreign domain truth  
**EVENTS CONSUMED:** Authorized domain/layer events through explicit contracts  
**AUTHORIZATION REQUIRED:** Tenant/workspace isolation; replay authorization; ABA boundary preserved  
**MIGRATION REQUIRED:** BUILD-33 additive migrations 0171+ only  
**LOCKED SPECS AFFECTED:** DA v1.1, BO v1.1, BI v1.0, DT v1.0, SIM v1.0, ADI v1.0, ABA v1.0, Cold-Start v1.0 compatibility only

No locked layer specification is superseded by BUILD-33.

---

## 4. Source-of-truth boundary

The canonical Event Ledger owns only:

- immutable event history;
- event identity/version;
- correlation and causation;
- provenance and evidence classification;
- delivery lineage;
- replay evidence;
- contract/schema identity.

It does **not** become the authoritative state store for:

- Commerce orders, sales, payments, customers or refunds;
- Operations inventory, procurement, suppliers, workforce or assets;
- Finance ledgers, cash, payables, receivables or budgets;
- Business Administration profiles, roles, policies or authority;
- BI analytical evidence;
- Digital Twin modeled state;
- Simulation future outcomes;
- ADI recommendations;
- Approved Business Action authorization state;
- Outcome Monitoring results;
- Continuous Learning models/knowledge.

A ledger event may describe that a fact occurred. It does not transfer ownership
of the underlying business fact to DATA.

---

## 5. Nine-layer traceability rule

BUILD-33 must preserve the trace chain where applicable:

```text
source data
↓
operational event
↓
BI evidence
↓
Twin snapshot
↓
Simulation run
↓
Decision
↓
Approval
↓
Execution
↓
Outcome
↓
Learning
```

Events may reference these artifacts by stable IDs. BUILD-33 must not flatten
them into one generic payload or silently overwrite historical evidence.

---

## 6. Cold-Start provenance amendment

The v1.0 canonical envelope had generic provenance metadata but did not require
the architecture-mandated evidence classification.

v1.1 therefore requires every canonical business event to carry an explicit
evidence class:

```text
ACTUAL
ASSUMPTION_BASED
BENCHMARK_BASED
ESTIMATED
FORECAST
SIMULATION
```

Rules:

1. ACTUAL means directly observed or transactionally recorded business reality.
2. ASSUMPTION_BASED means user/system assumptions before sufficient observation.
3. BENCHMARK_BASED means external/peer/industry benchmark-derived.
4. ESTIMATED means inferred current-state value, not directly observed.
5. FORECAST means predicted future value.
6. SIMULATION means scenario/model output.

This classification must be preserved through publication, ledger persistence,
replay and downstream consumption.

No event derived from assumptions, benchmarks, estimates, forecasts or
simulation may be presented downstream as ACTUAL merely because it was stored
in the canonical Event Ledger.

### Required contract amendment

`BusinessEventProvenance` must gain a mandatory evidence classification for
canonical events, or the envelope must carry an equivalent mandatory field.

Preferred contract:

```ts
type EvidenceClass =
  | 'ACTUAL'
  | 'ASSUMPTION_BASED'
  | 'BENCHMARK_BASED'
  | 'ESTIMATED'
  | 'FORECAST'
  | 'SIMULATION';

interface BusinessEventProvenance {
  evidenceClass: EvidenceClass;
  sourceSystem?: string;
  sourceRecordId?: string | null;
  sourceReference?: string | null;
  publicationPackageId?: string | null;
}
```

Canonical events with no provenance/evidence classification must fail validation
unless an explicitly documented legacy-compatibility adapter supplies the
classification.

---

## 7. Action/approval boundary

BUILD-33 may record and route events about decisions/actions but must never create
a path that bypasses Approved Business Action.

Forbidden:

```text
Simulation → Event Relay → Operations mutation
ADI → Event Relay → POS/Finance mutation
Outcome Monitoring → Event Relay → automatic rollback
```

Required high-level flow remains:

```text
Simulation
↓
AI Decision Intelligence
↓
Approved Business Action
↓
Business Operations / owning execution domain
↓
Real-world execution
```

Replay of an action-related event must not re-execute the action automatically.

---

## 8. Migration 0171 reconciliation

`0171_create_business_event_ledger.sql` is architecture-compatible in concept
because it creates an append-only event-history store under DATA without moving
business state ownership.

Before BUILD-33 completion it must additionally prove:

- evidence classification is persisted;
- provenance survives round-trip persistence;
- tenant/workspace RLS is fail-closed;
- application roles cannot mutate historical records;
- ledger rows cannot become an alternate operational write model.

0171 remains provisional until these v1.1 requirements are implemented and
tested.

---

## 9. Migration 0172 compatibility hold

Current `0172_harden_eventing_scope.sql` is **NOT architecture-approved as
currently written**.

Reason:

The historical event transport schema contains structures that may have
repository-global or platform-global semantics, especially
`events.event_subscriptions`. Adding nullable tenant/workspace columns and then
replacing RLS with strict tenant+workspace equality can make existing rows with
NULL scope invisible to application paths. That risks silently changing
historical event-delivery semantics and can break existing layer contracts.

The same compatibility concern applies to pre-existing historical rows in:

- `events.inbox_events`;
- `events.dead_letter_events`;
- `events.event_subscriptions`;
- `events.event_delivery_attempts`.

### Required 0172 redesign before implementation resumes

The replacement migration must explicitly classify each row/table scope as one
of:

```text
TENANT_WORKSPACE
TENANT_GLOBAL
PLATFORM_GLOBAL
```

and preserve historical/global semantics.

A safe design may use one of:

- explicit `scope_type` plus nullable tenant/workspace keys;
- separate global and tenant-scoped policies;
- a compatibility view/adapter;
- additive scoped tables while preserving the historical global registry.

The final design must prove:

1. existing global subscriptions remain visible to authorized relay/system code;
2. tenant-scoped consumers cannot read other tenant/workspace delivery data;
3. historical records remain reproducible;
4. no existing event producer or consumer contract silently changes;
5. rollback is understood;
6. migration is deterministic.

Until that redesign is frozen, 0172 must not be treated as merge-ready.

---

## 10. Domain/private-data rule

BUILD-33 repositories may persist event infrastructure data only.

They must not become generic access layers for querying domain-private tables.

Consumers should receive governed contracts/events/read models rather than
directly querying another domain's private operational state.

---

## 11. Guided Mode / UX compatibility

BUILD-33 has no direct Experience-layer UI deliverable, but it must preserve
metadata required by Guided Mode and future layer guidance.

Event contracts must therefore retain enough information for downstream layers
to explain:

- what happened;
- whether the evidence is actual/assumed/estimated/etc.;
- where it came from;
- what artifact caused it;
- which action/decision/outcome it relates to.

BUILD-33 must not force Experience to infer provenance from opaque payloads.

---

## 12. Specification version decision

BUILD-33 v1.0 → BUILD-33 v1.1.

This is a **compatible minor version amendment** because it:

- preserves the original BUILD-33 objective;
- preserves DATA ownership of event infrastructure;
- preserves all eight platform domains;
- preserves all nine lifecycle layers;
- adds mandatory architectural constraints;
- adds explicit Cold-Start provenance classification;
- blocks a potentially incompatible migration until redesigned.

It does not authorize a new domain, layer, source of truth or execution path.

---

## 13. Required implementation corrections before resume

Before BUILD-33 runtime work continues:

- [ ] Amend canonical event contract with evidence classification.
- [ ] Persist evidence classification in the canonical ledger.
- [ ] Update validator and registry tests.
- [ ] Update EventLedgerRepository round-trip mapping.
- [ ] Redesign 0172 for global + tenant/workspace compatibility.
- [ ] Add migration tests for legacy/global rows.
- [ ] Add live PostgreSQL RLS tests for scoped rows.
- [ ] Add replay tests proving ABA/action boundaries cannot be bypassed.
- [ ] Add provenance tests proving non-ACTUAL evidence stays non-ACTUAL.

Only after these corrections may the architecture gate be reopened.

---

## 14. Merge gate

PR #22 must not merge until all of the following are true:

- dual architecture validated;
- source-of-truth boundary preserved;
- v1.1 specification frozen and checksummed;
- 0172 compatibility redesign accepted;
- Cold-Start provenance implemented;
- contracts remain backward compatible;
- authorization/ABA boundaries remain intact;
- migrations deterministic;
- rollback documented;
- full required CI and live PostgreSQL tests pass;
- BUILD-33 completion report records v1.1 compliance.

---

## 15. Governance state after amendment

```text
BUILD-33.status = in_progress
BUILD-33.architectureGate = paused
BUILD-33.specificationVersion = 1.1
BUILD-34+ = blocked
PR #22 = draft / DO NOT MERGE
```

Implementation may resume only after the v1.1 amendment is frozen, recorded in
queue state, and the migration/provenance corrections above are applied.
