# INFINICUS — SIMULATION ENGINE
## LOCKED / FROZEN SPECIFICATION — v1.0

**Status:** LOCKED / FROZEN  
**Architecture Layer:** 5 — Simulation  
**Project:** INFINICUS Decision Intelligence Platform  
**Specification Version:** 1.0  
**Freeze Date:** 2026-10-04  
**Cross-Layer Dependency:** Must comply with `INFINICUS Layer Guidance & Cold-Start Standard v1.0`.  
**Change Rule:** No silent edits. Future changes require a new version (`v1.1`, `v2.0`, etc.) with explicit change notes.

---

## 1. Purpose

The INFINICUS Simulation Engine tests possible future states of a business by applying controlled scenario changes to either a versioned Business Digital Twin or, for cold-start businesses, an explicitly assumption-based initial model.

It uses probabilistic simulation, scenario comparison, sensitivity analysis, risk analysis, operational constraints, dependency propagation, and calibrated historical evidence to estimate ranges of possible outcomes before a change is made to the real business.

> **Digital Twin tells you where the business is. Simulation tells you where different choices could take it.**

---

## 2. Locked Core Principle

> **Digital Twin = current modeled reality. Simulation = possible futures.**

Simulation is not the source of current business truth and cannot directly mutate Business Operations.

---

## 3. Operating Modes

### 3.1 Existing Business — Live Twin Mode

Primary path:

```text
BUSINESS DIGITAL TWIN
        ↓
SELECT VERSIONED SNAPSHOT
        ↓
CHOOSE SCENARIO
        ↓
ADJUST VARIABLES
        ↓
APPLY CONSTRAINTS + DEPENDENCIES
        ↓
RUN MONTE CARLO
        ↓
COMPARE OUTCOMES
        ↓
RISK + SENSITIVITY
        ↓
SIMULATION VERDICT
        ↓
AI DECISION INTELLIGENCE
```

Known business data must be prefilled from the selected Twin snapshot. Existing businesses must not be forced to re-enter prices, staff, inventory, suppliers, capacity, demand, margins, cash, or other known baselines.

### 3.2 New Business — Cold Start Mode

Cold Start Mode may use:

- Business idea
- Startup capital
- Location
- Target customers
- Product/service prices
- Marketing budget
- Team size
- Competition
- Founder experience
- Industry profile
- Expected costs
- Expected sales
- Approved benchmarks
- Owner assumptions

Every output must preserve provenance such as `ASSUMPTION-BASED`, `BENCHMARK-BASED`, `ESTIMATED`, or `SIMULATION`.

---

## 4. Simulation Basis

Every run must declare its basis and preserve:

- Twin snapshot ID or Cold Start model ID
- Dataset version
- Model version
- Data maturity level
- Source quality
- Calibration status
- Simulation confidence
- Run configuration

Example:

```text
SIMULATION BASIS
Twin Snapshot: DT-20261004-1442
Data Maturity: Level 3
Twin Confidence: 92%
```

---

## 5. Scenario-First UX

For existing businesses, the default starting point is:

```text
WHAT DO YOU WANT TO TEST?

[PRICE CHANGE]
[SUPPLIER FAILURE]
[STAFF CHANGE]
[DEMAND CHANGE]
[COST SHOCK]
[NEW BRANCH]
[ASSET FAILURE]
[INVENTORY CHANGE]
[CUSTOM SCENARIO]
```

Only variables relevant to the selected scenario should be exposed by default.

---

## 6. Baseline vs Proposed

Baseline-vs-proposed comparison is mandatory.

```text
VARIABLE              CURRENT      PROPOSED
Price                 2.500        2.800
Staff                 12           14
Marketing             500          700
Demand                420          420
Food Cost %           28%          28%
```

The baseline must come from the Twin for established businesses whenever possible.

---

## 7. Monte Carlo Modeling

Simulation outputs must be probabilistic, not presented as guarantees.

Example:

```text
Expected Profit: 96,400 KWD
Likely Range:    72,000–121,000 KWD
P10:             58,000 KWD
P50:             94,000 KWD
P90:            131,000 KWD
```

### Run Precision Modes

```text
QUICK            500 runs
STANDARD       5,000 runs
HIGH CONFIDENCE 25,000 runs
```

The UI must explain that more runs reduce Monte Carlo sampling noise but do not repair weak assumptions or poor model structure.

---

## 8. Distribution Visualization

The Simulation Engine should visualize baseline and proposed outcome distributions so users can see changes in:

- Expected outcome
- Volatility
- Downside exposure
- Survival probability
- Tail risk

---

## 9. Risk Metrics

Relevant scenarios should expose, where applicable:

- Survival Probability
- Expected Profit
- Cash End Balance
- Break-Even Probability
- Probability of Cash Exhaustion
- Best Case
- Worst Case
- P10 / P50 / P90
- Downside Risk

Advanced methods such as Value at Risk or Expected Shortfall may be added where appropriate.

---

## 10. Sensitivity Analysis

Sensitivity must answer:

> **Which variables matter most?**

Example:

```text
Impact on Profit
Price                 38%
Demand                24%
Food Cost             18%
Staff Cost            12%
Supplier Lead Time     8%
```

---

## 11. Scenario Comparison

Scenario comparison is first-class.

Users should be able to compare:

```text
CURRENT
vs
SCENARIO A
vs
SCENARIO B
vs
SCENARIO C
```

Typical metrics include:

- Revenue
- Operating Profit
- End Cash
- Survival Probability
- Risk
- Capacity Utilization
- Customer Impact
- Supplier Exposure

---

## 12. Simulation Verdict

Simulation may produce:

- `GO`
- `MODIFY`
- `STOP`

This must be labeled **Simulation Verdict**, not final business authorization.

Example:

```text
VERDICT: MODIFY

✓ Expected profit +24%
✓ Survival probability +8pp
⚠ Downside volatility +19%
⚠ Capacity reaches 94%

Suggested adjustment:
Test a smaller price increase.
```

Final recommendation belongs to AI Decision Intelligence. Authorization belongs to Approved Business Action.

---

## 13. Simulation Confidence / Calibration

Simulation Confidence must derive from traceable factors such as:

- Twin confidence
- Historical depth
- Data completeness
- Model calibration quality
- Scenario extrapolation distance
- Benchmark dependency
- Source quality

For a startup, confidence may be low because there is no operating history. For a mature business, confidence may be high when calibration is strong.

---

## 14. Cold-Start Simulation

Cold-start simulation is a major capability and may test:

- Customer volume below expectations
- Rent increases
- Slower sales ramp
- Hiring delays
- Cost shocks
- Lower starting staff
- Alternative pricing
- Different operating models

All outputs must preserve assumption and benchmark provenance.

---

## 15. Assumption Stress Testing

The engine must not simply accept optimistic founder assumptions.

Example:

```text
Customers/day
60
80
100
120
```

The system should estimate how business viability changes across the tested range.

---

## 16. Constraint-Aware Simulation

Simulation must respect real constraints from the Twin.

Example:

```text
Projected Demand: 710 orders/day
Current Capacity: 600 orders/day

CAPACITY VIOLATION:
Demand exceeds current operating capacity by 110 orders/day.
```

The model must not assume unlimited resources where known constraints exist.

---

## 17. Dependency-Aware Simulation

Simulation must propagate dependency effects.

Example:

```text
Supplier B failure
      ↓
Beef Patty unavailable
      ↓
Burger XL / Chicken Burger / Steak
      ↓
Revenue / Cash / Customer availability
```

Dependency-aware propagation is mandatory where relevant.

---

## 18. Economy and External Context

Simulation may use governed contextual inputs such as:

- Inflation
- Exchange rates
- Fuel prices
- Commodity prices
- Interest rates
- Seasonal indicators
- Regional demand factors

These inputs must retain provenance.

---

## 19. Customer Effects

Simulation may model:

- Demand response
- Price sensitivity
- Churn
- Retention
- Conversion
- Basket changes
- Customer segment effects

Such outputs must be calibrated where possible and labeled with confidence.

---

## 20. Forecast vs Simulation Boundary

**BI Forecast:** what is likely if the business continues approximately as it is.  
**Simulation:** what could happen if variables or conditions are deliberately changed.

This distinction is locked.

---

## 21. Immutable Simulation History

Every simulation run must preserve an immutable run record with:

- `simulation_run_id`
- Twin snapshot ID
- Input dataset version
- Scenario type
- Baseline parameters
- Proposed parameters
- Assumptions
- Constraints
- Dependencies
- Monte Carlo configuration
- Number of runs
- Random seed where applicable
- Model version
- Results
- Risk metrics
- Sensitivity results
- Simulation Verdict
- Confidence
- Report
- Timestamp
- Initiating user/system

This supports reproducibility, Outcome Monitoring, and Continuous Learning.

---

## 22. Reporting

Simulation reports should summarize:

- Scenario question
- Simulation basis
- Baseline
- Proposed changes
- Assumptions
- Constraints
- Dependencies
- Results
- Probability ranges
- Risk
- Sensitivity
- Comparison
- Verdict
- Confidence
- Model/version metadata
- Twin snapshot reference

---

## 23. User-Facing Navigation

Recommended v1.0 navigation:

```text
SIMULATION

Setup
Results
Compare
Risk
Sensitivity
Forecast
Customers
Economy
Verdict
History
Report
```

Advanced:

```text
Advanced
├── Model Configuration
├── Run Settings
├── Random Seed
├── Distributions
└── Diagnostics
```

Generic strategy cards such as Safe Growth, Lean Startup, High Growth, and Investor Perspective are primarily Cold Start tools. Established businesses should default to their current Twin baseline.

---

## 24. Mandatory Layer Guide

### WHAT THIS LAYER DOES
> Tests possible futures before you change the real business.

### LOOK FOR
- Outcome ranges
- Probability of success
- Downside risk
- Sensitive variables
- Trade-offs
- Worst-case exposure

### WHAT TO DO
- Choose a business question
- Adjust variables
- Run scenarios
- Compare outcomes
- Review risk and sensitivity
- Send the preferred scenario to Decision Intelligence

### NEXT BEST ACTION
Must be contextual.

Example:

```text
Supplier B dependency is HIGH.
[TEST SUPPLIER FAILURE]
```

---

## 25. Guided Mode and Progressive Disclosure

Guided Mode should explain:

- Scenario choices
- Monte Carlo outputs
- Confidence
- Risk ranges
- Why a verdict was produced
- Cold-start assumptions

Advanced controls such as distributions, seeds, calibration, and diagnostics should remain accessible without overwhelming the default experience.

---

## 26. Data Maturity Awareness

### Level 0 — No Data
Cold-start setup, benchmarks, assumptions.

### Level 1 — Assumption-Based
Stress testing and low-confidence simulated outputs.

### Level 2 — Early Operational Data
Mixed actual + assumed calibration.

### Level 3 — Established Historical Data
Twin-driven simulation and stronger distributions.

### Level 4 — Mature Intelligence
High-confidence calibration, rich dependencies, and stronger decision/outcome comparison.

---

## 27. Output to AI Decision Intelligence

Simulation should publish structured scenario evidence including:

- Scenario ID
- Twin snapshot ID
- Scenario variables
- Outcome ranges
- Probability metrics
- Risk
- Sensitivity
- Constraints
- Dependencies
- Verdict
- Confidence
- Alternatives

AI Decision Intelligence may then form a business recommendation.

---

## 28. Output to Outcome Monitoring

Simulation must publish enough information to compare predicted vs actual:

- Predicted outcome
- Actual outcome
- Predicted risk
- Actual risk
- Expected timeline
- Actual timeline
- Assumed constraints
- Real constraints

---

## 29. Output to Continuous Learning

Simulation history must support learning from:

- Forecast error
- Scenario error
- Confidence error
- Distribution calibration
- Decision outcomes
- Repeated assumption failures
- Constraint misses
- Dependency misses

---

## 30. Non-Responsibilities

Simulation does not:

- Define current operational truth
- Replace the Digital Twin
- Replace BI
- Authorize business action
- Directly execute operational change
- Present probabilities as guarantees
- Hide benchmark dependency
- Hide assumptions
- Silently alter prior runs
- Override deterministic Business Operations rules

---

## 31. Locked Internal Flow

```text
BUSINESS DIGITAL TWIN
        ↓
SELECT SNAPSHOT
        ↓
SELECT SCENARIO
        ↓
ADJUST PARAMETERS
        ↓
APPLY CONSTRAINTS + DEPENDENCIES
        ↓
MONTE CARLO
        ↓
RESULTS / RISK / SENSITIVITY / COMPARISON
        ↓
SIMULATION VERDICT
        ↓
AI DECISION INTELLIGENCE
```

Cold-start path:

```text
INITIAL BUSINESS MODEL
        ↓
ASSUMPTIONS + BENCHMARKS
        ↓
STRESS TEST
        ↓
MONTE CARLO
        ↓
SCENARIO RESULTS
```

---

## 32. Locked Product Principle

> **Simulation should help the user test a change before risking the real business.**

The default experience should be scenario-oriented and understandable to a business owner, while advanced probabilistic controls remain available through progressive disclosure.

---

## 33. Locked Architecture Statement

The INFINICUS Simulation Engine is the probabilistic future-state testing layer of the platform.

For established businesses, it begins from a versioned Business Digital Twin snapshot and applies controlled scenario changes while respecting current constraints, dependencies, calibrated historical behavior, and business context.

For cold-start businesses, it begins from an explicitly assumption-based initial model and uses governed benchmarks, assumptions, and stress testing.

It produces probabilistic outcome ranges, scenario comparisons, sensitivity analysis, risk analysis, confidence, and a Simulation Verdict, but it does not authorize or directly execute business action.

> **Digital Twin tells you where the business is. Simulation tells you where different choices could take it.**

---

# FREEZE CONTROL

**Specification:** INFINICUS Simulation Engine v1.0  
**State:** FROZEN / LOCKED  
**Freeze Date:** 2026-10-04  
**Cross-Layer Standard:** Layer Guidance & Cold-Start Standard v1.0  
**Permitted Change Method:** New version only (`v1.1`, `v2.0`, etc.)  
**Silent edits:** PROHIBITED  
**Previous Layer:** Business Digital Twin v1.0  
**Next Architecture Review:** AI Decision Intelligence Layer
