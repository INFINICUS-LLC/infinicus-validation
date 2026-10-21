# BLOCK POS-8b — Printer registry (migration 0208)

Status: IMPLEMENTED — VALIDATION PENDING (CI). **Migration 0208 is NOT applied to production** (written and proven on throwaway PostgreSQL 16 only). Planned into the Phase W2 window — see `docs/architecture/reconciliation/PHASE_W2_ADDENDUM_0208.md`.

## What it adds
- `business_operations.printers` (migration `0208_create_printers.sql`): name (1–80, trimmed), kind `receipt|kitchen`, connection `browser|network|bluetooth|usb`, paper 58|80, is_default, status `active|retired`, retired_at, created_by, timestamps.
- Invariants enforced by the database, not only the application: active names unique per business (case-insensitive); at most one active default per business and kind; a retired printer is never the default; `retired_at` is set exactly when retired; paper only 58/80. Printers are retired, never deleted.
- RLS: same fail-closed tenant + workspace policy as every business_operations table; `updated_at` trigger via `set_updated_at()`.
- **No device address is stored** (no IP, MAC, device path). The device shell keeps the physical address on the device (contract: BLOCK-POS-8D1-DEVICE-BRIDGE.md). The API refuses any extra field such as `address` (strict schema).
- API (`apps/api/src/routes/printers.ts`): `POST /v1/businesses/:id/printers`, `GET …/printers`, `POST …/printers/:printerId/default`, `POST …/printers/:printerId/retire`. Writes need the existing permission `bo:admin` and an Idempotency-Key; reading needs `bo:read`; all go through `requireBusinessWorkspace`. The first active printer of a kind becomes its default.
- Repository: `PrinterRepository` (`packages/database/src/repositories/bo/PrinterRepository.ts`).

## Not in this block
No web screen for printers yet; no use of the registry by the receipt print path (8c: print-job log, templates, kitchen routing; 8d-2: shell). Nothing reads the registry today, so applying 0208 changes no behaviour.

## Verification (local, throwaway PostgreSQL 16)
- Migration applied through the migration gate on a fresh database; re-run is a no-op (idempotent).
- `printers.integration.test.ts`: 11 tests (live DB + real Fastify): defaults, uniqueness, retire, validation, permissions, idempotency replay, isolation, direct RLS as the application role, direct constraint violations. 4 mutations (first-is-default, unset-previous, permission, business scope) caught.
- Reference fingerprint `reference-0208.pg16.*` (hash `c2daa833c2f83c70`) generated with the committed fingerprint SQL; the method was first validated by reproducing the committed 0207 reference byte for byte (`bbd6bd1f31ad9ea9`) on the same database after dropping the new table. `REF_0208_PG16` added to the discovery script; its architecture test (37) passes.
- Rollback: `DROP TABLE business_operations.printers;` then `DELETE FROM _migrations WHERE filename = '0208_create_printers.sql';` (in the migration header). Valid because nothing else references the table.
