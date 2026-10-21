# DECISION RECORD — POS-9 offline selling (native device shell)

| Field | Value |
|---|---|
| Date of decision | 2026-10-21 |
| Decision owner | The owner of INFINICUS (decisions given in the owner's own message of 2026-10-21) |
| Status | **OWNER DECISIONS APPROVED. IMPLEMENTATION IS NOT AUTHORIZED.** This document records decisions only. |
| Source memo | `docs/implementation-queue/DESIGN-POS-9-OFFLINE-MODE.md` (merged in PR #211, commit `c431d08`). The memo is **not rewritten**; it remains the design reference, and where this record and the memo differ in wording, this record is the authority. |
| Scope of this record | Documentation only. No code, migration, schema, API, shell, storage, authentication or production change. |

## 1. Decisions D1–D8

| # | Decision | Owner decision | Status |
|---|---|---|---|
| D1 | Offline selling | **Option B approved.** Build offline selling exclusively inside the native device shell, after POS-8d-2 is available. Until then, preserve the existing online-only POS and the offline downtime procedure. | APPROVED |
| D2 | Architecture amendment | **Approved**, with the exact wording in section 2. Server authority over final transaction amounts is not weakened. | APPROVED |
| D3 | Offline limits | Maximum offline duration **24 hours**. Maximum queued sales **100**. Maximum individual sale value: **not decided** (section 3). | PARTIAL — monetary cap PENDING |
| D4 | Price drift | **Honour the price shown to the customer where policy permits**, record the difference, and send every other conflict to owner/admin review. Payment consistency is preserved. | APPROVED (policy details open, section 7) |
| D5 | Payment methods | **Cash only** during offline operation. No offline card transactions in the initial version. | APPROVED |
| D6 | Offline storage | **Encrypted storage inside the native device shell only.** The NA-04 browser-storage restrictions are preserved. | APPROVED |
| D7 | Receipts and cash drawer | Offline receipts must clearly state **PROVISIONAL**. Final receipt numbers are issued after server synchronization. Provisional receipts are **not tax documents**. Cash drawer opening remains permitted for cash transactions under the existing rules. | APPROVED |
| D8 | Exception resolution | Only an authorized owner or administrator holding **`bo:admin`** may resolve offline exceptions. **Every resolution records its reason and preserves append-only evidence.** | APPROVED |

## 2. The approved architecture amendment (exact wording)
**Replaces the frozen rule:** "The server computes every total."

**With:**
> "The server computes every final total. A device without a connection may show and print a provisional total, computed with the same exact minor-unit rules, labelled provisional. The server recomputes it on sync; the server's total is the record, and any difference is stored and surfaced, never hidden."

Conditions that come with the amendment and are part of this decision:
- Server authority over **final** transaction amounts is unchanged. A provisional total is never the record.
- If the server's total would exceed what was paid, **no order is created**; the sale goes to the exceptions list (the database payment-consistency invariant is never bent).
- Provisional receipts say in plain words, in the receipt's language, that they are provisional, that the final receipt number is issued after sync, and that they are not tax documents (D7).
- The amendment applies **only** to native-shell offline selling approved here (D1, D6). It does not permit provisional totals in the browser or anywhere else.

**Where the old wording is still written (not edited by this record, to keep the change reviewable):**
- `docs/implementation-queue/DESIGN-POS-9-OFFLINE-MODE.md` (quotes it as the "current" rule, section 6).
- `docs/implementation-queue/BLOCK-POS-7A-CONNECTION-AWARE-COUNTER.md` (lists offline selling as out of scope "because the server must compute every total").
No source code contains the phrase (searched). Aligning those two documents, and any place the rule is recited in a future block document, is a separate documentation step; until then this record governs.

## 3. Remaining monetary-cap decision (D3)
- **Not invented.** No monetary figure is set by this record.
- Currency-specific caps (a maximum single sale value per currency, for example KWD, USD, JPY) must be **separately approved by the owner before offline selling is enabled** anywhere.
- Until approved, the cap is undefined and offline selling must not be switched on (OFF-5 and enablement are blocked, section 7).

## 4. Native-shell dependency on POS-8d-2
- Offline selling exists **only** in the native device shell. POS-8d-2 (the shell) is **not started**; only the web side (8d-1, contract v1, `printEscPos`) exists.
- Until the shell exists, nothing offline is built into the web counter; POS-7a behaviour stays (offline blocks actions, one safe retry with the same Idempotency-Key), and the downtime procedure applies (section 7: it is not yet written).
- What offline needs from the shell beyond 8d-1: an encrypted on-device database (key in the platform keystore, behind PIN/device lock); a persistent-storage capability exposed to the counter (a new bridge contract version; v1 is printing only); sync scheduling and session handling; wipe-on-logout and device-revocation behaviour.
- There is no production web host for the counter (owner statement and Cloudflare project list, 2026-10-21); a browser offline mode would serve nobody and would breach NA-04. This is why D6 confines storage to the shell.
- 8d-2 owner prerequisites (still open): confirm Capacitor/Android (assumed, never confirmed), an Android SDK CI runner, an owner-held signing key, a tablet and a network thermal printer for testing. None can be built or tested in the current sandbox.

## 5. Offline stage names (OFF-1 to OFF-5)
Approved names, replacing the memo's lettered stages 9a–9e. **They must not be confused with the already merged POS-9a business tab bar (PR #207), which is a separate, finished scope.**

| Stage | Name | Memo's earlier label |
|---|---|---|
| OFF-1 | Server offline sale processing | 9a |
| OFF-2 | Native encrypted storage | 9b |
| OFF-3 | Offline selling interface | 9c |
| OFF-4 | Exception management | 9d |
| OFF-5 | Hardening and monitoring | 9e |

## 6. Migration reservations (planning only)
- **0210: reserved for per-product kitchen routing.**
- **0211 or later: reserved for OFF-1.**
- **Allocation check (2026-10-21):** `main` ends at `0209_create_print_jobs.sql`. No migration numbered 0210 or higher exists on any remote branch (every branch was inspected). Two documents mention these numbers: the design memo says the offline server stage would need "0210 or later" (**superseded by this record**: offline takes 0211 or later, 0210 is kitchen routing), and the Phase W2 plan lists per-product kitchen routing as "a later migration 0210" (**consistent** with this record). Both numbers are unallocated today.
- These are reservations on paper. **No migration is created or executed.** Other development sessions (for example the Core Architecture session) may take numbers; the check must be repeated when a migration is actually written.
- **Neither is part of Phase W2.** Phase W2 stays exactly as prepared (section 8). Each future migration gets its own plan, rollback block, local proof and window.

## 7. Architecture preservation requirements
All of the following are unchanged by this decision and bind every OFF stage:
- Server authority over **final** sale totals.
- Integer minor-unit accounting (KWD 3, USD 2, JPY 0); no floating-point money.
- Append-only financial records; payments exactly sum to the order total (the existing consistency trigger is the backstop).
- Idempotency on every write (`client_sale_id` is the key for an offline sale).
- NA-04 browser-storage restrictions (no localStorage, IndexedDB or cookies in the web client; only the existing tab-scoped entries).
- Tenant, workspace and business isolation, with row-level security. The schema has **no branch concept** (checked), so isolation is tenant + workspace + business.
- Existing authorization (`bo:read`, `bo:write`, `bo:admin`) and session contracts; no new permission is created by this record.
- The device clock is not trusted; the server records its own receive time next to the device time.
- No card data is ever processed or stored (D5).

## 8. Implementation dependencies and remaining blockers
**Sequence (each block separately authorised; none started):** Gate 0 (this record, then the monetary cap) -> **POS-8d-2 native-shell preparation** -> OFF-1 -> OFF-2 -> OFF-3 -> OFF-4 -> OFF-5. OFF-1 and OFF-4 can be built before the shell but are not testable end to end without it.

**Recommended next development block (not authorised by this record): POS-8d-2 native-shell preparation**, subject to the owner's separate authorization.

**Open items:**
1. **D3 monetary caps** per currency: owner decision pending; blocks enablement.
2. **D4 policy details:** "where policy permits" is not yet defined. The conditions under which the customer-shown price is honoured (for example any size limit on the difference, or product edits that always go to review) are to be fixed when OFF-1 is designed, and approved by the owner. Everything outside the policy goes to review.
3. **Downtime procedure** (the one-page paper-slip procedure referred to in D1): **not yet written.** The memo describes it; the document does not exist. Needs authorization to write.
4. **8d-2 prerequisites** (section 4).
5. **Alignment of the two documents** that still recite the old rule (section 2): not done here.
6. **Phase W2 is separate** (below).
7. Housekeeping unrelated to this decision: the three vite/launch-editor allowlist entries are due for review on 2026-11-06 (issue #24); the POS-7b decision write-up and the 0210 kitchen routing block are not started.

**Phase W2 (separately controlled, unchanged by this record).** Release SHA `ccadbf51be90c35377e21b73ceda77a1d455a805`; migrations 0202–0209. **Not authorised.** It stays unauthorised until the owner issues a separate explicit "authorise Phase W2" for a named window. This record adds nothing to it, changes nothing about the prepared release, and does not touch production.

## 9. What this record does not do
It does not implement offline selling, modify POS source code, create or run migrations, change authentication or browser-storage contracts, deploy or merge anything, modify production, begin POS-8d-2, or interfere with the separate INFINICUS Core Architecture development session.
