# BLOCK POS-8f — Printers and print log screen (web only)

Status: IMPLEMENTED — VALIDATION PENDING (CI). No migration, no API change, no production action. Uses the POS-8b and POS-8c APIs as merged.

## What it adds
New page `/businesses/:businessId/printers` ("Printers and print log"), linked from the counter next to Sales history.
- **Printers**: active printers (name, kind, connection, paper width, Default badge) with *Make default* and *Retire* (retire takes an explicit confirmation); retired printers listed separately, read-only.
- **Add a printer**: name, kind (receipt/kitchen), connection (browser/network/Bluetooth/USB), paper (80/58 mm), optional "make it the default". The form is checked locally (name 1–80, trimmed) before anything is sent.
- **Recent prints**: the last 50 attempts, newest first: kind, trigger (automatic / reprint / sent by cashier), time, route (device app / browser), printer name, and *Printed* or *Failed: <fixed reason>*. The log holds no receipt content, so neither does the screen.
- Written in our own words: 403 "Only an owner or admin can change printers.", duplicate name, retired-as-default, "Printers are not available on this server yet" (API/DB not migrated), a lost connection says nothing was confirmed and to check the list first. Raw server text is never shown.

## Rules kept
- The server decides everything (bo:admin for changes, uniqueness, defaults); every change carries an Idempotency-Key; one change at a time; stale loads cannot overwrite newer ones; offline disables changes.
- **No printer address is entered or shown**: the network/Bluetooth/USB address is set in the device app (8d contract).
- Nothing stored in the browser. Guard NA-05 extended (not weakened): the printers page is a listed tenant page whose controller must use the scoped client, `scope: this.scope` and idempotency keys.

## Known limits
- A config write whose answer is lost is not auto-retried (a repeat click uses a new key; names are unique and default/retire are naturally repeatable, so a duplicate cannot arise).
- No rename/edit of an existing printer (retire and add instead), no print-log filtering or paging beyond the last 50.
- The page is reachable only by its link from the counter until the business tab bar ("go with A") exists.

## Verification
Web suite 26 files / 317 tests; lint, typecheck, build and browser-secret scan pass; 16 new tests; 8 of 8 mutations caught (trim, double submit, stale load, forbidden wording, silent log failure, default button, retire confirmation, offline lock).
