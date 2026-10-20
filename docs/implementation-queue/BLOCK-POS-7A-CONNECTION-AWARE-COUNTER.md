# BLOCK POS-7a — Connection-aware counter (code only, no storage)

| Field | Value |
|---|---|
| Date | 2026-10-20 |
| Status | Implemented in a draft pull request. **Web only: no API, migration or production change.** Works with today's API (idempotency keys already exist on every order and register write). |
| Authorization | Owner: "POS-6b, POS-7". |
| **Architecture conflict reported, NOT implemented** | POS-7 as listed in `BLOCK-POS-COUNTER-INTERFACE-PREPARATION.md` also asks for a *draft order cache*. `clientBoundary.architecture.test.ts` is a reviewed rule: no cookies, no `localStorage`/`indexedDB`, and "the selection (two ids) is the only thing ever stored" (tab-scoped `sessionStorage`). Saving a draft order, or an unconfirmed action with its Idempotency-Key, across a page reload would break that rule, so it was left out. **Owner decision needed** (see below). |

## What it does (inside the existing rules)
- **Offline blocks actions.** The browser's online flag is only a hint (`false` is reliable, `true` is not proof the API is reachable). When it says offline, a banner explains why and every order and register action is disabled (New order, Open, Remove, quantity, Complete, Discount, Void, Open/Close register, product tiles). Retry and Discard wait for the connection.
- **Safe automatic retry on return.** If an action's outcome was unknown (the answer was lost), it stays held in memory with its Idempotency-Key. When the connection comes back (offline then online, once per return) the SAME action is retried with the SAME key, so the server replays the answer it already gave: the sale is recorded **exactly once**. Covers both the order session and the register controller.
- **Leave warning.** The browser asks for confirmation before the tab is closed or reloaded while an action is in flight or unconfirmed (the only copy of its key lives in the page).
- Nothing is stored in the browser; the server stays the source of every total.

## Files
`lib/client/connectivity.ts` (pure: `watchReconnect`, `shouldWarnBeforeLeave`, browser source), `counter/connection.tsx` (hooks and banner), `counter/order-panel.tsx` and `register-panel.tsx` (`offline` prop), `counter/page.tsx` (wiring), `tests/client.connectivity.test.tsx` (13 tests, four mutants killed including "retry with a new key").

## Decision for the owner
If a reload during an unconfirmed action must not lose the retry, the smallest safe extension is to keep that one pending action (method, path, body, key, ids; no card data, only slip numbers) in **tab-scoped `sessionStorage`**, cleared on sign-out, on success and when the tab closes. That needs the client-boundary rule amended on purpose and reviewed. **Recommendation:** approve it as its own block (POS-7b) once real tills are in use; until then the leave warning plus the open-orders list (which shows what the server really recorded) cover the gap.

## Not done
Draft order cache and any offline *selling* (the server must compute every total), persisted retry across reloads (decision above), background sync, a service worker, reachability probing beyond the browser's online flag, retry with backoff for repeated failures while "online".
