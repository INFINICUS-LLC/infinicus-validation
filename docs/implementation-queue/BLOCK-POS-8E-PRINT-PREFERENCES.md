# BLOCK POS-8e — Print choices remembered for the tab session (web only)

Status: IMPLEMENTED — VALIDATION PENDING (CI). No migration, no API change.

Owner-authorized exception ("go sessionStorage"): the two print choices (automatic print after payment, paper width 80/58 mm) are kept in `sessionStorage` under `inf_web_print_v1` so a reload does not reset them. Closing the tab forgets them.

- Only `lib/client/printPrefs.ts` touches storage; the value is `{auto, paperMm}`, validated on read (bad value → defaults), every call wrapped so a missing/blocked storage never breaks the counter.
- Guard NA-04 updated narrowly: sessionStorage writers are exactly workspaces.ts and printPrefs.ts; printPrefs has one `setItem` storing only those two fields. NA-05 (no URL reads) untouched. Still no localStorage, cookies or IndexedDB.
- Read after mount (not during server render) to avoid a hydration mismatch.

Follow-up (needs #201, POS-8d-1): inside the device shell, automatic printing should default ON when nothing is stored yet.
