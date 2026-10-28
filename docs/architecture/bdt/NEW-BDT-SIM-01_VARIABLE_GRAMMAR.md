# NEW-BDT-SIM-01: performance hand-off variable grammar

The vocabulary a future **Simulation-owned** intake must parse. It is implemented as `PERFORMANCE_VARIABLE_GRAMMAR` (`packages/workflow/src/performance/performanceBaseline.ts`) and every produced variable is tested against it. Not yet ratified by the owner (proposal A3 in `NEW-BDT-SIM-01.SEC-01_REMEDIATION.md`). Simulation's intake is not implemented by this work.

## Variable codes (`DTVariableInput.variableCode`)
- `domain.financial.status`, `domain.sales.status`: always the text `PROVIDED` (a hand-off is made only when both domains are provided).
- `financial.<CUR>.<metric>` and `sales.<CUR>.<metric>`: `<CUR>` is a three-letter upper-case ISO 4217 code. **The currency is part of the code; there is no cross-currency variable and no total.**

| Code | Value | Unit |
|---|---|---|
| `financial.<CUR>.revenue`, `.expenses`, `.goodsReceived`, `.averageOrderValue`, `.grossProfit` | decimal text, optional `-`, at most 4 decimals | `<CUR>` |
| `financial.<CUR>.grossProfit.marginPercent` | decimal text | `%` |
| `financial.<CUR>.revenue.orders` | integer text | `orders` |
| `financial.<CUR>.expenses.items`, `financial.<CUR>.goodsReceived.lines`, `...grossProfit.evidence.saleLines`, `...saleLinesWithCost` | integer text | `items` / `lines` |
| `financial.<CUR>.averageOrderValue.state` | `OK` / `NO_ORDERS` / `UNSUPPORTED_CURRENCY` | none |
| `financial.<CUR>.grossProfit.state` | `COMPUTED` / `NO_REVENUE` / `INSUFFICIENT_COST_EVIDENCE` | none |
| `sales.<CUR>.completedOrders`, `.voidedOrders`, `.openOrders`, `.otherStatusOrders` | integer text | `orders` |
| `sales.<CUR>.grossMinor`, `.discountMinor`, `.netMinor`, `.averageOrderNetMinor` | integer text (minor units) | `<CUR> minor units (10^-N)`, N from 0 to 4 |
| `sales.<CUR>.reconciles` | boolean | none |

`averageOrderValue`, `grossProfit` and `averageOrderNetMinor` are **absent** (not zero) when BI states they cannot be stated; their `.state` variable says why. A missing value is never read as 0.

## Reading rules
1. Every value is exact **text** (or the boolean above), never a JavaScript number. A consumer must parse text with its own exact decimal or integer type and must **fail closed** on any code, unit or value outside this grammar.
2. A value is only meaningful with its unit; `<CUR>` in the code must equal the currency in the unit.
3. Financial decimals (major units) and sales integers (minor units) are different fields and are never merged; `sales.<CUR>.netMinor / 10^N` is the sales view of the same completed orders that `financial.<CUR>.revenue` states (the twin already verified they agree before publishing).
4. Values are recorded facts from governed BI reports, not forecasts; no uncertainty distribution is assigned.
5. `quality.confidence` is the Twin Confidence recorded in `twin_confidence_scores` (basis stored), never a forecast confidence.
