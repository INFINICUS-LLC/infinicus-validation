# NEW-BDT-01: governed BI -> Business Digital Twin performance representation

Workstream CORE-ARCHITECTURE-01. Layer: Business Digital Twin (consumes Business Intelligence). Status: merged in #270 (`bfc9914`), not deployed by this workstream. Follow-up integrity hardening is proposed separately.

## What it does
The twin represents the **financial** (`bi-financial-report/1`, NEW-BI-01) and **sales** (BI-SALES-1) reports Business Intelligence already derived for one business and one reporting period. BI stays the only KPI authority; the twin copies those figures **verbatim, per currency**, and adds provenance and an integrity digest. Chain: BO -> BI -> BDT. The twin imports no Business Operations code and reads no BO table.

| Route | Permission | Behaviour |
|---|---|---|
| `POST /v1/businesses/:businessId/twin/business-performance` body `{from,to}` | `dt:write`, active subscription, Idempotency-Key | 201 published; 200 `NOT_PUBLISHED` with a code (nothing persisted); 400 invalid period |
| `GET  /v1/businesses/:businessId/twin/business-performance[?from&to]` | `dt:read` | newest published state, integrity re-verified; 404 if none |

## Contract `bi-performance-evidence/1` (additive, `packages/handoff-contracts/src/bi-performance-evidence.ts`)
`{ businessId, period, financial, sales, crossCheck, evidenceDigest }`. Each domain is `PROVIDED` (provenance = BI contract + period + SHA-256 of the canonical source report as received; BI coverage codes; per-currency figures) or `MISSING` (code + detail, no figures). Financial decimals and sales minor units stay in their own fields and are never converted or summed across currencies.

## Rules (tested)
- **Reporting-period consistency:** both reports are requested for the same period and each must state exactly that period and business, else `BI_EVIDENCE_INCONSISTENT`.
- **Cross-report check (a comparison, not a calculation):** per currency, financial revenue (count and exact decimal) must equal sales completed orders and net (minor units aligned with exact BigInt). A disagreement is never represented.
- **Missing / insufficient:** one unavailable domain is `MISSING` with its code; both unavailable is `BI_EVIDENCE_MISSING`; nothing recorded in the period is `BI_EVIDENCE_INSUFFICIENT` (absence of data is not data). BI states such as `INSUFFICIENT_COST_EVIDENCE` pass through unchanged.
- **Integrity:** `evidenceDigest` = SHA-256 of the canonical evidence; every read re-verifies it, so a stored copy altered behind the twin's back reports `evidence_digest_mismatch`.
- **Deterministic:** the same BI reports always give the same evidence and digest.
- **Follow-up integrity hardening (draft):** sealed evidence owns a detached copy of the BI figures and reporting period. Malformed stored domain/currency arrays, coverage, provenance, dates and cross-check rows return an invalid integrity verdict instead of throwing. No new KPI or frozen contract is introduced. Reproducible negative proofs: `node infinicus-platform/scripts/test-bdt-performance-mutations.mjs` (13 targeted mutants).
- **Existing lifecycle:** definition -> instance -> snapshot -> value + evidence -> validate -> publish in one shared tenant transaction, exactly as the inventory item twin; published snapshots are immutable and the P0-3 freshness rule applies. Writes only twin tables.

## Frozen-contract finding (owner attention)
The frozen BUILD-12 `bi-to-dt` handoff carries package metrics as plain numbers with no currency, so it cannot carry exact per-currency money, and these reports are computed on request, not published as packages. It is **not used or modified**. The merged AC-2 Block 6 precedent (twin consumes BI evidence through a structural read side) is followed, with an additive contract. If the owner wants this routed through BUILD-12 publication packages instead, that needs a versioned contract change.

## Not in this block
Trend, comparison and per-product detail (the twin holds the period figures only); other domains (inventory has its own twin); a twin-to-simulation handoff of this state; scheduling or automatic publication; any recommendation or action.
