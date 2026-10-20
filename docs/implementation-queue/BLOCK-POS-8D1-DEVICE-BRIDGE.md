# BLOCK POS-8d-1 — Device bridge and ESC/POS printing (web side)

Status: IMPLEMENTED — VALIDATION PENDING (CI). Web only. No migration, no API change, no production action.
Stacked on POS-8a (#200).

## Scope split of 8d
- **8d-1 (this block):** the web counter can print through a native shell, with no dialog, and open the cash drawer.
- **8d-2 (NOT started):** the native shell itself (Android app wrapping the web counter, e.g. Capacitor), with network (TCP 9100), Bluetooth and USB printer plugins, printer settings kept on the device, signing and distribution. Needs: Android SDK in CI, an owner decision on repository placement, signing keys (owner-held), and test hardware. It could not be built or tested in the sandbox used for this block (Java/Gradle present, Android SDK absent).

## Contract, version 1 (what the shell must provide)
```
window.InfinicusDevice = { version: 1, printEscPos(dataBase64: string): Promise<{ ok: boolean; error?: string }> }
```
- The shell injects it before the page loads, sends the decoded bytes to the attached printer, and answers `ok: true` only when the printer accepted them.
- The shell, not the web page, holds the printer address and settings. The web counter stores nothing and knows no address (rules NA-04/NA-05 unchanged).
- The answer is treated as untrusted: anything other than `{ ok: true }` is a failure; no answer within 15 s is a failure.

## Behaviour
- No shell → browser printing (POS-8a), unchanged.
- Shell present → ESC/POS bytes (48 columns on 80 mm, 32 on 58 mm), initialise, bold total, feed and cut.
- Cash drawer: the standard pulse is added only for the **automatic** print of a sale paid (partly) in **cash**. Never on a reprint, never for card-only.
- Plain thermal printers cannot shape Arabic and differ in code pages, so only printable ASCII is encoded. Any other character (e.g. an Arabic business name) falls back to the browser/HTML receipt for that receipt.
- A shell failure is reported ("sale is recorded… press Print receipt") and is **not** retried through the browser: the shell may already have printed, and a second paper copy is worse than a message.

## Known limits
- The automatic print still needs the cashier to tick the box (in-memory, POS-8a); in the shell this should default on — a decision for 8d-2/sessionStorage.
- Arabic receipts on ESC/POS need rasterised printing; planned inside the shell (render HTML to bitmap), not in the web.
- Drawer pulse timing/pin differ per drawer; defaults are the common ones.
