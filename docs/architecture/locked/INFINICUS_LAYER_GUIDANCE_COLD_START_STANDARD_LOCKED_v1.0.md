# INFINICUS — LAYER GUIDANCE & COLD-START STANDARD
## LOCKED / FROZEN CROSS-LAYER STANDARD — v1.0

**Status:** LOCKED / FROZEN  
**Applies to:** All 9 INFINICUS layers  
**Project:** INFINICUS Decision Intelligence Platform  
**Version:** 1.0  
**Freeze Date:** 2026-10-04  
**Change Rule:** No silent edits. Future changes require a new version with explicit change notes.

---

## 1. PURPOSE

Every INFINICUS layer must remain understandable to a nontechnical business user even when the underlying architecture is complex.

Each layer must immediately explain:

1. What this layer does
2. What the user should look for
3. What the user should do
4. What the next best action is

The system must use progressive disclosure so advanced technical detail remains available without overwhelming the default experience.

## 2. MANDATORY LAYER GUIDE

Every layer must provide a compact Layer Guide containing:

### WHAT THIS LAYER DOES
A one-sentence explanation of the layer's purpose.

### LOOK FOR
A short, contextual set of items requiring attention.

### WHAT TO DO
Clear actions the user can take inside the layer.

### NEXT BEST ACTION
A dynamic recommendation based on the current state of the business and the current layer.

The next action must not be generic when the system has enough context to provide a more specific one.

## 3. GUIDED MODE

INFINICUS should support an optional **Guided Mode**.

When enabled, Guided Mode may provide:
- Layer explanations
- Contextual highlights
- Recommended next step
- Simplified terminology
- Inline help
- Empty-state instructions
- Data-quality explanations
- Confidence explanations
- Warnings before consequential actions

When disabled, experienced users may use a denser professional interface.

Guided Mode changes presentation, not the underlying architecture or business rules.

## 4. PROGRESSIVE DISCLOSURE

The default experience should show only what is needed for the current task.

Example:

```text
Revenue ↓ 12%
```

Expanded:

```text
Why?
- Supplier cost ↑ 11%
- Sales volume ↓ 4%
- Discount frequency ↑ 8%
```

Advanced detail:

```text
Data sources
Calculation formula
Record count
Confidence
Correlation
Model version
```

Technical complexity must remain accessible, but it must not be forced into the default experience.

## 5. COLD-START BUSINESS MODE

INFINICUS must support businesses with no historical data.

A new business must not be blocked by empty dashboards or be required to wait for operational history.

Cold-Start Mode must construct an initial business model from:
- Business type
- Products or services
- Prices
- Expected costs
- Opening inventory
- Staff plan
- Supplier terms
- Rent and fixed expenses
- Operating hours
- Expected customer volume
- Branches
- Opening cash position
- Industry benchmarks
- Economic context
- Explicit owner assumptions

All non-observed outputs must be clearly labeled according to provenance.

Allowed labels include:
- `ASSUMPTION-BASED`
- `BENCHMARK-BASED`
- `ESTIMATED`
- `FORECAST`
- `SIMULATION`
- `ACTUAL`

The system must never present assumption-based or benchmark-based values as actual operating evidence.

## 6. DATA MATURITY LEVELS

### LEVEL 0 — NO DATA
No meaningful operational history exists.

Primary experience:
- Business setup
- Guided onboarding
- Data connection
- Assumption capture

### LEVEL 1 — ASSUMPTION-BASED
The initial business model exists but is primarily based on owner inputs and external benchmarks.

Primary experience:
- Initial Digital Twin
- Scenario testing
- Planning
- Benchmark comparison

### LEVEL 2 — EARLY OPERATIONAL DATA
Real transactions and operational events have begun accumulating but history remains limited.

Primary experience:
- Early KPIs
- Low/medium-confidence trends
- Real-data calibration
- Comparison of assumptions vs observed activity

### LEVEL 3 — ESTABLISHED HISTORICAL DATA
Enough history exists for robust recurring patterns and stronger forecasts.

Primary experience:
- Historical analytics
- Trend analysis
- Calibrated simulation
- Driver analysis

### LEVEL 4 — MATURE BUSINESS INTELLIGENCE
Rich, reliable, longitudinal business data is available.

Primary experience:
- High-confidence analytics
- Mature anomaly detection
- Calibrated forecasting
- Advanced simulation
- Decision-performance learning

## 7. MATURITY-AWARE BEHAVIOR

Every layer must adapt to the current maturity level.

The platform must not display false certainty when data maturity is low.

Example:

```text
Revenue Trend
Status: NOT ENOUGH REAL DATA
Current basis: Industry benchmark + owner assumptions
Confidence: LOW
```

Later:

```text
Revenue Trend
History: 12 months
Data completeness: 98%
Confidence: HIGH
```

## 8. NEW BUSINESS ENTRY PATH

```text
NEW BUSINESS
    ↓
BUSINESS SETUP + ASSUMPTIONS
    ↓
DATA ACQUISITION
    ↓
INITIAL DIGITAL TWIN
    ↓
SIMULATION / PLANNING
    ↓
BUSINESS OPERATIONS BEGIN
    ↓
REAL DATA ACCUMULATES
    ↓
BUSINESS INTELLIGENCE MATURES
    ↓
MODELS ARE RECALIBRATED
```

This is a valid architecture path and must not be treated as an exception.

## 9. EXISTING BUSINESS ENTRY PATH

```text
EXISTING BUSINESS
    ↓
HISTORICAL DATA
    ↓
DATA ACQUISITION
    ↓
BUSINESS OPERATIONS
    ↓
BUSINESS INTELLIGENCE
    ↓
DIGITAL TWIN
    ↓
SIMULATION
```

Both paths must converge into the same canonical platform architecture.

## 10. GLOBAL PRODUCT RULES

> **Every INFINICUS layer must explain its purpose, show what deserves attention, and provide a clear next action.**

> **No user should need to understand the nine-layer architecture in order to use INFINICUS successfully.**

> **INFINICUS must work before a business has historical data, while becoming progressively more evidence-driven as real operating history accumulates.**

> **Assumptions, forecasts, simulations, benchmarks, estimates, and actual values must remain visually and semantically distinguishable.**

---

# FREEZE CONTROL

**Specification:** INFINICUS Layer Guidance & Cold-Start Standard v1.0  
**State:** FROZEN / LOCKED  
**Silent edits:** PROHIBITED  
**Applies to:** DAL, BO, BI, Digital Twin, Simulation, AI Decision Intelligence, Approved Business Action, Outcome Monitoring, Continuous Learning
