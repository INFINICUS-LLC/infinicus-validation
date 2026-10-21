# BLOCK POS-9a — Business tab bar (web only)

Status: IMPLEMENTED — VALIDATION PENDING (CI). No migration, no API change, no production action. (Numbered 9a to leave the earlier "9 offline mode" label for its own design decision; this is the tabs block approved as "go with A".)

## What it adds
A tab bar shared by every screen of one business (`app/(client)/businesses/[businessId]/layout.tsx`): **Counter · Sales · Printers · Workflow · Decision history**. The open screen is marked (`aria-current="page"` and visually); the bar scrolls sideways on a narrow screen and is hidden when printing. The ad-hoc links it replaces (counter → sales/printers, "Back to counter" on sales/printers, "Back to workflow" on history) were removed.

## Decisions to know
- **Registers and Products are not tabs.** They are panels of the Counter screen today, not pages; a tab that leads nowhere new would mislead. They become tabs when they exist as screens.
- The business id comes from the page address and is accepted only if well-formed (same check each page makes); it carries no authority — every screen still verifies scope and permission per request. No `useParams` in the layout (guard NA-05 unchanged), no storage.
- Outside a business screen (the list, sign-in) nothing is drawn.

## Verification
Web suite 27 files / 324 tests (7 new); lint, typecheck, production build and browser-secret scan pass; 4 of 4 mutations caught (substring match, missing id check, dropped tab, everything current). Not viewed in a real browser (layout/CSS unverified visually).
