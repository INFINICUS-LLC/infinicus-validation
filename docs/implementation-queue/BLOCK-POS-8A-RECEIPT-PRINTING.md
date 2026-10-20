# BLOCK POS-8a — Receipt printing foundation (web only)

Status: IMPLEMENTED — VALIDATION PENDING (CI). No migration, no API change, no production action.

## What it does
- Builds a thermal-paper receipt document (80 mm or 58 mm wide) from the receipt the server already confirmed (`lib/client/printing.ts`).
- Prints it from a hidden frame, so only the receipt reaches the paper.
- **Automatic print**: a box on the counter ("Print the receipt automatically after payment", off by default) and a paper choice (80 / 58 mm). With it on, the receipt prints once, right after the server confirms the sale. The choice lives in memory for the page load only.
- **Reprint**: the Print receipt button, always available.
- **Failure**: a print failure never touches the sale; a message says the sale is recorded and Print receipt retries.
- Safety: all text is escaped; the document carries a content-security-policy (no scripts, no network); Arabic text uses `dir="auto"`; one automatic print per receipt (guard).

## Silent printing — what the browser allows
A web page cannot print silently by itself. The dialog is skipped only when the till's browser is started in kiosk-printing mode with the receipt printer as the default printer:
- Chrome / Edge on Windows, macOS, Linux: start with `--kiosk-printing` .
- iPad/Safari and Android Chrome: not possible; the dialog always appears. Block 8d (native device shell) removes this limit.

## Verified finding
Chromium ignores `@page { size: 80mm auto }` (invalid CSS) and falls back to Letter, so the page size is NOT set from CSS. The paper size comes from the printer profile (a roll of the same width); the receipt is laid out to exactly the paper width with zero margins. Layout checked by rendering at 80 mm and 58 mm: one page, no overflow, long item names wrap.

## Not in this block (later)
8b printer registry (migration) · 8c print-job log, templates, kitchen routing · 8d native shell: network/Bluetooth/USB printers, cash drawer · 9 offline mode.

## Architecture note / owner decision
The first design read `?autoprint=1&paper=58` from the page address. The frozen guards NA-04/NA-05 forbid reading anything from the URL, so this was dropped (guards untouched) in favour of the in-memory box. Cost: the cashier re-ticks the box after a reload. Decision for the owner: allow a tab-scoped `sessionStorage` entry for these two print choices (same pattern as the workspace selection) — recommended, small change in a later block.
