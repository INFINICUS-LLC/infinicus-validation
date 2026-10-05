# INFINICUS — DUAL-MODE EXPERIENCE STANDARD
## LOCKED / FROZEN CROSS-LAYER UX SPECIFICATION — v1.0

**Status:** LOCKED / FROZEN  
**Scope:** All 9 INFINICUS layers  
**Project:** INFINICUS Decision Intelligence Platform  
**Specification Version:** 1.0  
**Freeze Date:** 2026-10-05  
**Primary Implementation Domain:** EXPERIENCE  
**Change Rule:** No silent edits. Future changes require a new version (`v1.1`, `v2.0`, etc.) with explicit change notes.

---

## 1. PURPOSE

Every INFINICUS layer must support two presentation modes:

1. **Guided Mode**
2. **Professional Mode**

Both modes use the same underlying business state, authoritative data, contracts, calculations, models, permissions, audit trail, and governance rules.

> **Guided Mode simplifies the interface, not the intelligence.**

Professional Mode exposes greater analytical and operational depth without changing the underlying truth.

---

## 2. LOCKED CORE PRINCIPLE

The platform must never create separate engines, separate sources of truth, or different business logic for Guided Mode and Professional Mode.

```text
                    INFINICUS
                       │
              SAME PLATFORM STATE
                       │
          ┌────────────┴────────────┐
          │                         │
     GUIDED MODE             PROFESSIONAL MODE
          │                         │
   Explain + simplify        Expose + investigate
          │                         │
          └────────────┬────────────┘
                       │
                SAME 9 LAYERS
```

---

## 3. MODE DEFINITIONS

### Guided Mode

Designed for:
- non-professional users
- new business owners
- first-time users
- operators who need task-focused workflows
- users who prefer plain business language

Guided Mode should emphasize:
- simple language
- fewer primary controls
- recommended defaults
- contextual explanations
- progressive disclosure
- visible Next Best Action
- warnings explained in business terms
- task-oriented workflows
- guided onboarding
- minimal technical jargon

### Professional Mode

Designed for:
- analysts
- managers
- finance teams
- operations leaders
- administrators
- technical users
- advanced decision makers

Professional Mode should expose:
- full KPI detail
- full configuration
- diagnostics
- model metadata
- provenance
- advanced filters
- uncertainty
- confidence
- sensitivity
- scenario controls
- audit data
- version information
- export/reporting
- drill-down analysis

---

## 4. SAME INTELLIGENCE RULE

Both modes must use the same:

- Data Acquisition results
- Business Operations state
- Business Intelligence calculations
- Digital Twin snapshot
- Simulation engine
- AI Decision Intelligence output
- Approved Business Action controls
- Outcome Monitoring evidence
- Continuous Learning evidence

Mode selection changes presentation depth only.

---

## 5. AUTHORIZATION INDEPENDENCE

Experience mode does not grant authority.

These remain separate:

```text
BUSINESS STATE
Cold Start / Live Business

EXPERIENCE MODE
Guided / Professional

ACCESS AUTHORITY
Viewer / Operator / Manager / Approver / Admin
```

A user switching to Professional Mode does not gain permission to:
- approve payments
- change policies
- modify protected financial data
- deploy models
- change approval thresholds
- execute restricted actions

RBAC and policy controls remain authoritative.

---

## 6. COLD START INDEPENDENCE

Cold Start is not a presentation mode.

A business may be:

```text
Cold Start + Guided Mode
Cold Start + Professional Mode
Live Business + Guided Mode
Live Business + Professional Mode
```

All combinations must be valid where permissions allow.

---

## 7. GLOBAL MODE CONTROL

The primary mode selector belongs in the INFINICUS EXPERIENCE shell.

Recommended:

```text
MODE
● Guided
○ Professional
```

or a two-state segmented control:

```text
[ Guided Mode ] [ Professional Mode ]
```

The selected mode should persist across navigation.

Mode switching must not modify:
- business state
- model state
- data values
- source-of-truth ownership
- authorization
- audit history

---

## 8. MANDATORY GUIDANCE ELEMENTS

Every layer in Guided Mode must prominently expose:

### WHAT THIS LAYER DOES
A plain-language explanation.

### LOOK FOR
The most important items requiring attention.

### WHAT TO DO
The practical actions available.

### NEXT BEST ACTION
A contextual action based on current state.

Professional Mode may retain these in compact form or under a help/guide panel.

---

## 9. PROGRESSIVE DISCLOSURE

Guided Mode should reveal complexity in layers.

Example:

```text
Revenue ↓ 12%
```

Then:

```text
Why?
Supplier cost ↑ 11%
Sales volume ↓ 4%
Discount frequency ↑ 8%
```

Then:

```text
Advanced details
Data source
Formula
Confidence
Model version
Record count
```

Professional Mode may expose deeper detail immediately.

---

## 10. LAYER-BY-LAYER MODE BEHAVIOR

### 10.1 Data Acquisition

#### Guided Mode
Focus on:
- Upload Spreadsheet
- Connect POS
- Enter Manually
- Complete Business Setup
- Fix data issues
- Publish data

Explain mapping and missing information in plain language.

#### Professional Mode
Expose:
- schema mapping
- validation rules
- provenance
- lineage
- source priority
- conflicts
- rejected records
- data quality
- ingestion runs
- contract versions
- publication state

---

### 10.2 Business Operations

#### Guided Mode
Focus on:
- Sell
- Orders
- Expenses
- Stock
- Customers
- Staff
- Alerts
- Pending approvals

#### Professional Mode
Expose:
- transaction history
- inventory movements
- branch state
- margins
- tax components
- reconciliation
- workflow state
- exception queues
- audit trails
- operational controls

---

### 10.3 Business Intelligence

#### Guided Mode
Answer:

> **How is my business doing?**

Use simplified KPI cards, plain-language trends, and important findings.

#### Professional Mode
Expose:
- KPI definitions
- segmentation
- cohorts
- variance
- margins
- forecasting
- benchmarks
- provenance
- confidence
- drill-downs
- advanced reports

---

### 10.4 Business Digital Twin

#### Guided Mode
Present:

> **Your Business Right Now**

Show:
- health
- cash
- demand
- inventory
- staff
- customers
- suppliers
- risks
- bottlenecks

#### Professional Mode
Expose:
- modeled state
- dependencies
- constraints
- freshness
- uncertainty
- source lineage
- state transitions
- Twin diagnostics
- snapshot metadata

---

### 10.5 Simulation

#### Guided Mode
Start with:

> **What decision do you want to test?**

Examples:
- Raise prices
- Hire someone
- Open another branch
- Increase marketing
- Buy more stock
- Change supplier
- Try my own idea

The system should determine most technical defaults.

#### Professional Mode
Expose:
- Monte Carlo run count
- distributions
- assumptions
- scenario horizon
- sensitivity
- constraints
- P10/P50/P90
- risk decomposition
- calibration
- model configuration

---

### 10.6 AI Decision Intelligence

#### Guided Mode
Present:
- recommendation
- why
- expected impact
- risk
- confidence
- simple alternatives
- Review Action

#### Professional Mode
Expose:
- evidence chain
- all alternatives
- ranking
- confidence factors
- simulation references
- Twin state
- uncertainty
- evidence gaps
- counterarguments
- decision metadata

---

### 10.7 Approved Business Action

#### Guided Mode
Present:

> **Ready to make this decision real?**

Show:
- what will happen
- expected result
- risk
- approval requirement
- owner
- confirm / modify / stop

#### Professional Mode
Expose:
- authorization record
- exact parameters
- approvers
- segregation of duties
- policy checks
- execution plan
- rollback rules
- monitoring window
- immutable audit data

---

### 10.8 Outcome Monitoring

#### Guided Mode
Present:

> **Did the decision work?**

Show:
- expected vs actual
- simple result status
- major side effects
- whether continued monitoring is needed

#### Professional Mode
Expose:
- distributions
- variance decomposition
- attribution confidence
- execution fidelity
- side effects
- counterfactuals
- success criteria
- rollback thresholds
- prediction accuracy

---

### 10.9 Continuous Learning

#### Guided Mode
Present:

> **What has INFINICUS learned about your business?**

Show:
- important lessons
- model improvements
- recent learning events
- improvement in prediction quality
- next review action

#### Professional Mode
Expose:
- error decomposition
- drift detection
- calibration
- backtesting
- model versions
- decision performance
- learning confidence
- rule proposals
- governance state
- validation results

---

## 11. EXPECTED LOOK — GUIDED MODE

The approved Guided Mode visual direction is:

- dark INFINICUS theme
- neon green primary actions
- fewer cards and controls
- large plain-language explanation panel
- prominent Next Best Action
- large simplified KPI cards
- plain-language insight cards
- clear action buttons
- minimal jargon
- limited visible filters
- technical diagnostics hidden
- “How it works” always available

For Continuous Learning, the expected Guided Mode includes:

```text
CONTINUOUS LEARNING
Your business gets smarter over time

INFINICUS learns from real results

Next Best Action
3 improvements are ready
[REVIEW IMPROVEMENTS]

Key Insights for You
- Weekend demand is higher than expected
- Food costs are rising faster than expected
- Morning promotions bring more repeat visits

Performance is improving
Prediction Accuracy
Decision Success Rate
Better Recommendations

Recent Learning Events
```

---

## 12. EXPECTED LOOK — PROFESSIONAL MODE

The approved Professional Mode visual direction is:

- same dark INFINICUS shell
- denser analytics
- compact KPI summaries
- advanced tabs
- date ranges and filters
- model accuracy charts
- error analysis
- calibration comparisons
- learning queue
- update queue
- validation/backtesting
- decision-type performance
- assumption-vs-reality table
- model version metadata
- diagnostics available
- export/reporting available

For Continuous Learning, the expected Professional Mode includes:

```text
Overview
Learning Insights
Model Performance
Update Queue
Validation & Backtesting
Assumption Learning
History
```

with panels for:
- model accuracy trends
- error analysis
- learning impact
- key learnings
- model update queue
- decision-type performance
- assumption vs reality
- validation/backtesting
- recent learning events

---

## 13. VISUAL CONSISTENCY RULE

Both modes must remain recognizably INFINICUS.

Locked visual language:
- dark navy/black background
- neon green primary action/state
- blue for analytics/monitoring
- amber for caution/uncertainty
- red for critical/failure
- consistent typography
- consistent navigation shell
- consistent business identity
- consistent status semantics

The mode changes information density, not brand identity.

---

## 14. EXPERIENCE DOMAIN OWNERSHIP

Dual-mode presentation belongs primarily to:

```text
EXPERIENCE
├── guided-mode
├── professional-mode
├── mode-switcher
├── layer-guides
├── progressive-disclosure
├── help
├── onboarding
└── presentation-policy
```

Other domains must not fork their business logic for each mode.

---

## 15. IMPLEMENTATION RULE

Feature code must not create:

```text
guided-simulation-engine
professional-simulation-engine
```

or:

```text
guided-bi-calculation
professional-bi-calculation
```

Correct pattern:

```text
SAME ENGINE / SAME CONTRACT
        ↓
PRESENTATION ADAPTER
        ↓
GUIDED or PROFESSIONAL UI
```

---

## 16. MODE-SPECIFIC DEFAULTS

Guided Mode may use recommended defaults.

Professional Mode may expose configurable parameters.

However:

- defaults must be explicit
- assumptions must remain traceable
- switching modes must not silently change an already-running scenario
- consequential parameter changes must be user-confirmed where required

---

## 17. MODE TRANSITION

When switching Guided → Professional:

- preserve current page
- preserve current action
- preserve filters where practical
- preserve unsaved non-destructive context where safe
- reveal additional controls

When switching Professional → Guided:

- preserve business state
- preserve decisions
- preserve simulation inputs
- hide advanced controls
- summarize complex state

No destructive reset should occur solely because the mode changed.

---

## 18. ACCESSIBILITY & LANGUAGE

Both modes must support:
- localization
- readable status language
- keyboard accessibility where applicable
- clear status semantics
- tooltips/help
- responsive layouts

Professional terminology should still be explainable through “How it works.”

---

## 19. AUDIT RULE

Mode may be recorded as contextual metadata for UX analytics or debugging, but must not be used as a substitute for:
- permission
- approval
- authorization
- policy state
- source-of-truth state

---

## 20. ARCHITECTURE GUARDRAIL

Before any build involving Guided or Professional Mode, verify:

1. Same source of truth?
2. Same backend contract?
3. Same calculations?
4. Same model version?
5. Same authorization?
6. Same audit trail?
7. No duplicated business logic?
8. Cold Start remains independent?
9. Guided Mode still exposes enough explanation?
10. Professional Mode still exposes enough depth?

If any answer is unclear, stop and review architecture before implementation.

---

## 21. LOCKED PRODUCT PRINCIPLES

> **Guided Mode simplifies complexity without reducing intelligence.**

> **Professional Mode exposes complexity without changing truth.**

> **Mode controls presentation depth, not authority.**

> **One business state. One intelligence system. Two experience depths.**

---

# FREEZE CONTROL

**Specification:** INFINICUS Dual-Mode Experience Standard v1.0  
**State:** FROZEN / LOCKED  
**Freeze Date:** 2026-10-05  
**Applies To:** All 9 INFINICUS layers  
**Primary Domain:** EXPERIENCE  
**Cold Start Relationship:** Independent  
**Authorization Relationship:** Independent  
**Expected UX Direction:** Approved Guided vs Professional dual-mode mockup  
**Permitted Change Method:** New version only (`v1.1`, `v2.0`, etc.)  
**Silent edits:** PROHIBITED
