# INFINICUS — DATA ACQUISITION LAYER (DAL)
## LOCKED / FROZEN SPECIFICATION — v1.1

**Status:** LOCKED / FROZEN  
**Architecture Layer:** 1 — Data Acquisition  
**Project:** INFINICUS Decision Intelligence Platform  
**Specification Version:** 1.1  
**Freeze Date:** 2026-10-04  
**Supersedes for implementation:** DAL v1.0  
**Historical baseline:** DAL v1.0 remains preserved and immutable.  
**Cross-Layer Dependency:** Must comply with `INFINICUS Layer Guidance & Cold-Start Standard v1.0`.  
**Change Rule:** No silent edits. Future changes require a new version (`v1.2`, `v2.0`, etc.) with explicit change notes.

---

# 0. v1.1 CHANGE SUMMARY

DAL v1.1 preserves all DAL v1.0 architectural responsibilities and adds:

1. Mandatory Layer Guide:
   - What this layer does
   - Look for
   - What to do
   - Next best action
2. Guided Mode compatibility.
3. Progressive disclosure.
4. Cold-Start Business Mode.
5. Data Maturity Levels 0–4.
6. Startup business setup without historical data.
7. Explicit assumption/benchmark provenance.
8. Actionable empty states.
9. Transition of data from assumed → early actual → mature actual.
10. Startup readiness and downstream activation guidance.

No v1.0 responsibility is removed.

---

# 1. PURPOSE

The Data Acquisition Layer is the controlled business-data intake, preparation, standardization, quality-control, lineage, and routing layer of INFINICUS.

Its responsibility is to receive business information, understand what that information represents, preserve its origin, reorganize it into INFINICUS-standard business structures, assess readiness and quality, and publish the correct versioned datasets and business events to downstream layers according to their data requirements.

The DAL must support both:

- existing businesses with historical data; and
- new businesses with no historical operating data.

The DAL does **not** make business decisions, execute operational workflows, run strategic simulations, or generate final AI recommendations.

---

# 2. LOCKED CORE PRINCIPLE

> **DAL understands, prepares, validates, standardizes, versions, and routes business data. It does not make business decisions.**

For a new business, DAL also provides the controlled setup path for creating the initial business data model from explicitly labeled assumptions, opening-state records, and benchmarks.

---

# 3. PRIMARY INPUT SOURCES

DAL must support progressively:

- Spreadsheet files
- CSV files
- Excel workbooks
- POS systems
- Business databases
- APIs
- Manual data entry
- Accounting exports
- Inventory systems
- HR / staff systems
- Supplier systems
- Customer / loyalty systems
- Approved external business context feeds
- New-business setup forms

Spreadsheet ingestion remains a first-class capability.

---

# 4. BUSINESS DATA DOMAINS

## 4.1 Master Data
- Products
- Menu items
- Services
- Categories
- Employees
- Suppliers
- Customers
- Branches / locations
- Assets

## 4.2 Transaction Data
- Sales
- Purchases
- Payments
- Refunds
- Expenses
- Transfers
- Orders

## 4.3 Operational Data
- Inventory
- Stock movements
- Shifts
- Deliveries
- Production
- Open orders
- Reorder levels
- Supplier activity

## 4.4 Financial Data
- Revenue
- Costs
- Payroll
- Cash flow
- Margins
- Assets
- Liabilities
- Operating expenses

## 4.5 Context Data
- Promotions
- Seasons
- Events
- Competitor information
- Economic variables
- Market context
- Approved external factors

## 4.6 Cold-Start Setup Data
- Business type
- Products / services
- Prices
- Expected costs
- Opening inventory
- Staff plan
- Supplier terms
- Rent / fixed expenses
- Operating hours
- Expected customer volume
- Opening cash position
- Branch setup
- Owner assumptions
- Industry benchmarks
- Economic context

---

# 5. RAW DATA PRESERVATION

Every imported dataset must retain an immutable source record.

DAL must preserve:

- Source file or source-system reference
- Business ID
- Ingestion timestamp
- User or system initiating ingestion
- Source type
- Original sheet names
- Original row count
- Original column count
- File / payload hash where applicable
- Import batch ID
- Original values before transformation
- Parsing results
- Validation results
- Provenance class

Raw source data must never be silently overwritten by cleaned or transformed data.

---

# 6. DATA RECOGNITION AND SCHEMA DETECTION

DAL must determine what incoming data represents.

Example source columns:

```text
Name
Category
Selling Price
Cost
Quantity Available
```

Mapped to:

```text
product_name
category
selling_price
unit_cost
inventory_quantity
```

AI-assisted recognition is permitted, but accepted mappings must resolve into controlled INFINICUS schemas and remain reviewable.

Critical mappings must be auditable.

---

# 7. VALIDATION

DAL must validate incoming data before downstream publication.

Validation may include:

- Missing required values
- Invalid data types
- Negative or impossible quantities
- Invalid dates
- Duplicate records
- Broken relationships
- Currency inconsistencies
- Invalid identifiers
- Outlier detection
- Contradictory values
- Referential-integrity checks

Required statuses:

- `VALID`
- `WARNING`
- `REJECTED`
- `NEEDS_REVIEW`
- `AUTO_CORRECTED`

DAL must not silently invent critical financial or operational values.

---

# 8. CLEANING AND STANDARDIZATION

DAL must transform valid input into canonical INFINICUS formats.

Standardization includes where relevant:

- Field naming
- Data types
- Dates and times
- Currency
- Units of measure
- Product identifiers
- Employee identifiers
- Supplier identifiers
- Branch identifiers
- Category structures
- Missing-value handling
- Duplicate resolution
- Controlled vocabulary

Example:

```json
{
  "entity_type": "product",
  "product_id": "P-001",
  "product_name": "Burger XL",
  "category": "Food",
  "currency": "KWD",
  "selling_price": 2.500,
  "unit_cost": 1.050
}
```

---

# 9. ENTITY AND RELATIONSHIP MAPPING

DAL must establish relationships such as:

- Product belongs to Category
- Product uses Inventory Item
- Sale contains Product
- Sale occurred at Branch
- Sale was processed by Employee
- Purchase came from Supplier
- Expense belongs to Cost Category
- Staff member belongs to Department
- Customer generated Transaction
- Asset belongs to Branch

This converts flat source data into a usable business model.

---

# 10. CANONICAL BUSINESS MODEL

All downstream layers should consume canonical INFINICUS business entities rather than raw spreadsheet structures whenever possible.

The canonical model is the standardized representation of the business and the stable internal contract between DAL and downstream platform capabilities.

---

# 11. DATA CONTRACTS

DAL must not produce one giant generic dataset.

Each downstream consumer defines a data contract.

## 11.1 Business Operations Contract
May require:
- Product ID
- Current stock
- Supplier
- Reorder point
- Current price
- Active orders
- Current shifts
- Current staff
- Current customer activity

## 11.2 Simulation Contract
May require:
- Baseline values
- Historical sales
- Price
- Cost
- Demand history
- Inventory history
- Seasonality
- Variance
- Constraints
- Scenario variables
- Sensitivity inputs

## 11.3 Business Intelligence Contract
May require:
- Date
- Product
- Branch
- Sales
- Revenue
- Cost
- Margin
- Inventory movement
- Staff metrics
- Customer metrics

## 11.4 Digital Twin Contract
May require:
- Cash
- Inventory value
- Employees
- Branches
- Revenue
- Gross margin
- Suppliers
- Open orders
- Current liabilities
- Key operating constraints

---

# 12. DATA ROUTING

Conceptual flow:

```text
BUSINESS DATA
    ↓
DATA ACQUISITION
    ↓
Raw Preservation
    ↓
Schema Detection
    ↓
Validation
    ↓
Cleaning
    ↓
Standardization
    ↓
Entity Resolution
    ↓
Relationship Mapping
    ↓
Canonical Business Model
    ↓
Quality Scoring
    ↓
Version / Snapshot
    ↓
Data Contracts / Published Data Products
    ↓
BUSINESS OPERATIONS / BI / DIGITAL TWIN / SIMULATION / APPROVED CONSUMERS
```

Routing should use stable contracts, versioned datasets, and/or business-event distribution mechanisms.

---

# 13. SPREADSHEET-FIRST EXPERIENCE

DAL must support businesses that primarily operate through spreadsheets.

User-facing sections should support:

- Overview
- Sources
- Business Setup
- Products
- Menu Items
- Inventory
- Sales
- Staff
- Finance
- Customers
- Suppliers
- Assets
- Branches
- Raw Imports
- Data Issues
- Data Lineage
- Data Map
- Schema
- Runs
- Publish

Users must be able to inspect how uploaded fields map into canonical entities.

---

# 14. DATA QUALITY AND READINESS

DAL must calculate readiness by business domain and downstream use case.

Example:

```text
Sales             98%  READY
Inventory         94%  READY
Products         100%  READY
Staff             81%  WARNING
Finance           63%  INCOMPLETE
Customers         37%  LIMITED
```

Downstream readiness may include:

```text
BUSINESS OPERATIONS READINESS: 95%
SIMULATION READINESS:          87%
BI READINESS:                  92%
DIGITAL TWIN READINESS:        89%
```

Readiness must reflect completeness, validity, freshness, and reliability.

---

# 15. MISSING-DATA IMPACT

DAL must explain what is missing and the consequence.

Example:

```text
Detected:
✓ Products
✓ Inventory
✓ Staff

Missing:
✗ Historical Sales
✗ Supplier Lead Times
✗ Operating Expenses

Impact:
- Demand simulation confidence: LOW
- Cash-flow simulation: UNAVAILABLE
- Inventory recommendations: LIMITED
```

For a startup, missing historical data is not treated as an error if the business is correctly in Cold-Start Mode.

---

# 16. DATA LINEAGE AND PROVENANCE

Every important downstream value must be traceable.

```text
SOURCE
  ↓
ACQUISITION
  ↓
VALIDATION
  ↓
CLEANING
  ↓
STANDARDIZATION
  ↓
TRANSFORMATION
  ↓
CANONICAL MODEL
  ↓
PUBLISHED DATA PRODUCT
  ↓
DOWNSTREAM CONSUMER
```

The system must answer:

> Where did this value come from, how was it transformed, and which downstream layer used it?

---

# 17. VERSIONING AND SNAPSHOTS

DAL outputs must be versioned.

Identifiers may include:

- `ingestion_batch_id`
- `dataset_version`
- `dataset_snapshot_id`
- `schema_version`
- `transformation_version`
- `business_id`
- `source_reference`
- `created_at`

Downstream systems must be able to reference exact dataset states.

Large raw datasets should not be duplicated unnecessarily.

---

# 18. SECURITY AND GOVERNANCE

DAL must support:

- Business-level isolation
- Role-based access
- Source-level audit trails
- Import history
- Schema-change history
- Transformation history
- Retention rules
- Sensitive-field controls
- Approved downstream access
- Reproducible transformations

No downstream layer should bypass governance by consuming unvalidated raw data unless explicitly authorized.

---

# 19. COLD-START BUSINESS MODE

Cold-Start Mode is mandatory.

A business with no historical operating data must not encounter a dead-end or blank DAL.

The system must guide the user through creating an opening business model.

Recommended setup flow:

```text
NEW BUSINESS
   ↓
Business Type
   ↓
Products / Services
   ↓
Prices / Expected Costs
   ↓
Opening Inventory
   ↓
Staff
   ↓
Suppliers
   ↓
Fixed Expenses
   ↓
Operating Hours
   ↓
Opening Cash Position
   ↓
Expected Customers / Sales
   ↓
Branches
   ↓
Initial Canonical Business Model
```

The user may enter assumptions manually or use approved benchmark support.

---

# 20. ASSUMPTION AND BENCHMARK PROVENANCE

All non-observed values must be explicitly classified.

Required provenance classes include:

- `ACTUAL`
- `ASSUMPTION-BASED`
- `BENCHMARK-BASED`
- `ESTIMATED`
- `FORECAST`
- `SIMULATION`

Example:

```text
Expected Daily Customers: 60
[ASSUMPTION-BASED]
```

INFINICUS must never silently convert this into an actual value.

---

# 21. DATA MATURITY LEVELS

DAL must expose or contribute to the platform-wide maturity state:

### Level 0 — No Data
No meaningful business model or operating history.

### Level 1 — Assumption-Based
Opening model exists; primarily owner assumptions and benchmarks.

### Level 2 — Early Operational Data
Real transactions are accumulating.

### Level 3 — Established Historical Data
Enough history exists for robust recurring patterns.

### Level 4 — Mature Business Intelligence
Rich, reliable longitudinal data exists.

DAL must adapt its guidance according to this maturity level.

---

# 22. ASSUMPTION-TO-ACTUAL TRANSITION

The platform must preserve both original assumptions and subsequent actual observations.

Example:

```text
Expected Daily Customers
60
[ASSUMPTION-BASED]
```

Later:

```text
Observed Daily Customers
43
[ACTUAL — 7 DAYS]
```

Later:

```text
Average Daily Customers
51
[ACTUAL — 90 DAYS]
Confidence: HIGH
```

The original assumption remains historically available for later comparison and learning.

---

# 23. MANDATORY DAL LAYER GUIDE

DAL must comply with the Layer Guidance Standard.

### WHAT THIS LAYER DOES
> Bring your business information into INFINICUS and prepare it for the rest of the platform.

### LOOK FOR
Contextual examples:
- Missing information
- Mapping errors
- Low-quality records
- Outdated sources
- Validation warnings
- Incomplete downstream datasets

### WHAT TO DO
Contextual examples:
- Add or connect data
- Complete business setup
- Review detected issues
- Correct critical problems
- Publish validated datasets

### NEXT BEST ACTION
Must be dynamic.

Examples:

```text
No business data yet.
[START BUSINESS SETUP]
```

```text
12 records need review.
[REVIEW DATA ISSUES]
```

```text
Operations dataset ready.
[PUBLISH TO BUSINESS OPERATIONS]
```

---

# 24. GUIDED MODE

When Guided Mode is enabled, DAL should simplify terminology and guide the user through:

- Adding data
- Understanding detected fields
- Fixing critical errors
- Completing startup setup
- Publishing to downstream layers

Advanced details such as schema versions, hashes, transformation metadata, and lineage graphs should remain available through progressive disclosure.

---

# 25. ACTIONABLE EMPTY STATES

DAL must never show only:

> No data.

Instead it must explain:

- Why data is absent
- Whether the business is new or disconnected
- What minimum information is needed
- What the user should do next
- Which downstream capabilities will become available afterward

---

# 26. STARTUP READINESS

For a startup, DAL should calculate setup readiness separately from historical-data readiness.

Example:

```text
NEW BUSINESS SETUP

Products        READY
Prices          READY
Opening Stock   READY
Staff           READY
Suppliers       PARTIAL
Fixed Expenses  READY

POS Readiness: 92%
BI Maturity:   LEVEL 1
Simulation:    AVAILABLE WITH ASSUMPTIONS
```

This prevents startups from being penalized simply because history does not yet exist.

---

# 27. DOWNSTREAM ACTIVATION GUIDANCE

DAL should explain which layers can activate next.

Example:

```text
Business Operations
READY

Business Intelligence
EARLY MODE

Digital Twin
INITIAL MODEL AVAILABLE

Simulation
AVAILABLE — ASSUMPTION-BASED
```

---

# 28. NON-RESPONSIBILITIES

DAL does not:

- Make GO / MODIFY / STOP decisions
- Execute operational actions
- Run Monte Carlo simulations
- Produce final AI recommendations
- Replace BI
- Replace the Digital Twin
- Determine business strategy
- Automatically act on the business without downstream authorization
- Modify raw source records in place

---

# 29. ARCHITECTURAL BOUNDARY

DAL ends when business information has been:

1. Received or created through business setup
2. Preserved
3. Understood
4. Validated
5. Cleaned where applicable
6. Standardized
7. Related
8. Provenance-labeled
9. Quality-scored
10. Versioned
11. Packaged according to downstream contracts
12. Published or routed to approved consumers

---

# 30. LOCKED ARCHITECTURE STATEMENT

The INFINICUS Data Acquisition Layer is the controlled ingestion and business-data preparation layer of the platform.

It receives structured and semi-structured business information from spreadsheets, POS systems, APIs, databases, manual input, and new-business setup; preserves provenance; validates, cleans, classifies, standardizes, and relates the information into the canonical business model; assigns quality, maturity, readiness, and provenance states; creates versioned dataset snapshots; and publishes data products according to downstream contracts.

For businesses with no historical data, DAL must provide a guided Cold-Start path that creates an explicitly assumption-based opening business model and progressively replaces assumptions with real evidence as operations begin.

> **DAL prepares and routes evidence. It does not make the business decision.**

---

# FREEZE CONTROL

**Specification:** INFINICUS Data Acquisition Layer v1.1  
**State:** FROZEN / LOCKED  
**Freeze Date:** 2026-10-04  
**Historical Baseline:** DAL v1.0 — preserved  
**Cross-Layer Standard:** Layer Guidance & Cold-Start Standard v1.0  
**Permitted Change Method:** New version only (`v1.2`, `v2.0`, etc.)  
**Silent edits:** PROHIBITED  
**Next Layer:** Business Operations v1.1
