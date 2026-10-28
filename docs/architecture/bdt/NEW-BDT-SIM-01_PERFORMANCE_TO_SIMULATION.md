# NEW-BDT-SIM-01: Digital Twin -> Simulation hand-off of the business performance state

> **Superseded in part by SEC-01 (`NEW-BDT-SIM-01.SEC-01_REMEDIATION.md`).** The "confidence = 1 for corroborated facts" reasoning below was found unsupported: the hand-off now needs an owner-ratified Twin Confidence methodology (none exists, so it is closed), persists the complete envelope, and revalidates its BI source. Read that document for the current behaviour.

Workstream CORE-ARCHITECTURE-01. Layer: Business Digital Twin publishing to Simulation. Status: implemented on a draft PR, not merged, not deployed. Builds on NEW-BDT-01 (#270, merged).

## What it does
It turns the latest **published, integrity-verified** business performance twin state of a reporting period into a Simulation-ready package using the **existing, unchanged** twin machinery and the **frozen** `dt-to-sim` contract:

published twin snapshot -> published scenario baseline (one input per variable) -> DT insight package version -> DT publication package, readied and **dispatched** to `simulation` / `SIM-01`.

`POST /v1/businesses/:businessId/twin/business-performance/simulation-handoff` body `{from,to}`; `dt:write`, active subscription, Idempotency-Key. 201 handed off (the validated `DTToSIMHandoff` is returned); 200 replay of an existing hand-off, or `NOT_HANDED_OFF` with a named code (nothing persisted); 400 invalid period.

**Simulation's intake is Simulation's own act and is not performed here.** The twin writes only twin tables (verified by row counts, including `simulation.simulation_intake_packages`).

## Variables (the frozen contract's `variables`)
Verbatim BI figures as exact text with a unit; the currency is part of the variable code, so currencies never mix and there is no cross-currency total:
`financial.<CUR>.revenue` ("150.00", unit `USD`), `...expenses`, `...goodsReceived`, `...averageOrderValue(.state)`, `...grossProfit.state` and, only when BI computed it, `...grossProfit` and `...marginPercent`; `sales.<CUR>.netMinor` ("15000", unit `USD minor units (10^-2)`), `...completedOrders`, and the rest. No value is a number, so the contract's probabilistic-uncertainty rule does not apply and **no uncertainty distribution is invented**.

## Rules (tested)
- Ready only if the state is integrity-verified and **both** domains are provided (which implies the cross-check was performed); a partial, tampered, empty or forged-but-empty state is `NOT_SIMULATION_READY` / `TWIN_STATE_INTEGRITY_FAILED`.
- The hand-off must satisfy `validateDTToSIMHandoff`, checked **before** any write (placeholder ids) and again with the real ids inside the transaction; a failure rolls everything back.
- One transaction (the shared tenant transaction): a failure part-way leaves no baseline, input or package.
- Idempotent per snapshot version: the baseline code and the package idempotency key derive from it and are unique in the database; a repeat, or a concurrent duplicate, replays the existing package.
- Tenant/business isolation: the twin state, the replay lookup and the package are scoped by business and tenant (RLS).

## Contract findings (owner attention)
1. The frozen `dt-to-sim` contract requires a numeric `quality.confidence` in 0..1, which BI evidence does not supply. It is stated as **1 only for fully corroborated recorded facts** (both BI reports provided and agreeing) and means "recorded and cross-verified", **not** predictive confidence; anything less is refused rather than given an invented partial score. If Simulation should treat it as a forecast confidence, that needs an owner definition.
2. The contract has no money type; exact text values with a currency unit were used instead of numbers. The frozen contract, `bi-to-dt` and the NEW-BDT-01 contract are not modified.

## Additive repository reads (DT-owned, read-only)
`DigitalTwinSnapshotRepository.getPublishedVersion`, `DTPublicationPackageRepository.getByIdempotencyKey`.

## Not in this block
Simulation's receipt/acceptance of the package (a Simulation-owned block), running any scenario, recommendations, any action, scheduling, UI.
