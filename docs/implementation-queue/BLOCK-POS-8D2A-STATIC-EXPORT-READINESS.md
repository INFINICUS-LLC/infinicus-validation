# BLOCK POS-8d-2a — Web static-export readiness

Status: IMPLEMENTED — VALIDATION PENDING (CI). Web only. No migration, no API change, no deploy, no production action. Authorised by the owner: "go 8d-2a: Q2 = bundled; I approve updating the NA-05 guard" (2026-10-21).

## Why
The native shell must carry the counter as files inside the app (decision Q2 = bundled; offline selling cannot start from a hosted page). The prep block found the counter could not be exported: `output: "export"` failed because the `[businessId]` pages had no `generateStaticParams`, and a business id exists only at run time.

## What changed
- **One id source, the address.** `lib/client/locationPath.ts` (a small injectable source, like `connectivity.ts`) reads the **path** of the address; `useBusinessId()` (`businesses/[businessId]/use-business-id.ts`) returns the id only if `businessIdFromPath` accepts it (a well-formed id), else null; null while the server renders. The five screens (counter, sales, printers, workflow, history) and the tab bar use it instead of `useParams`/`usePathname`. In an export the framework's route parameter is the build-time placeholder, never the real business, so it must not be used.
- **Placeholder build.** `businesses/[businessId]/layout.tsx` exports `generateStaticParams()` returning only `{ businessId: '_' }`. `_` is not a valid id, so an opened placeholder address shows the usual "address is not valid" notice. A normal server build is unchanged (any real id still renders on demand).
- **Export switch.** `next.config.mjs`: `NEXT_OUTPUT=export` turns on `output: 'export'` + `trailingSlash`; off by default. `scripts/build-export.mjs` (cross-platform, run as `pnpm --filter @infinicus/web run build:export`) builds into `apps/web/out/` and `scripts/check-export.mjs` verifies it: the 10 required screens (home, sign-in, workspaces, console, businesses list, and the five business screens under `_`), no source maps, no api folder, **no real business id baked in**. `apps/web/out/` is git-ignored.
- **The one rule the shell must reproduce** (`scripts/serve-export.mjs`, also a dependency-free dev server): an address `/businesses/<id>/<screen>[/...]` is answered with the file `/businesses/_/<screen>[/...]`; everything else is served as is. The browser keeps the real address, the page reads the id from it.
- **CI:** one step after Build runs the export check.

## NA-05 guard update (approved by the owner)
`tests/noServerAccess.architecture.test.ts` listed the pages allowed to use `useParams` and required each to validate with `z.string().uuid()`. It now requires, with the same intent (the id is validated before use, no identity comes from the URL): no screen uses `useParams` or `usePathname`; exactly the five screens use `useBusinessId()` as `const businessId = useBusinessId();` (a lookup key, never authority); the reader reads `window.location.pathname` only (search and fragment are still refused by the existing check); the validator keeps the well-formed-id regex. Two page-render tests stub the new hook (through the **real** validator) instead of `useParams`.

## Verification
- Web suite **29 files / 331 tests**; lint, typecheck, secret scan and dependency scan pass. 6 of 6 mutations caught (reading the fragment, no id validation, a screen using the route/path hook again, a valid-looking placeholder, the server snapshot returning the real id, the fallback rule disabled).
- **Pristine checkout (the CI-equivalent environment):** normal build then export in CI order, no side effects on tracked files; export check passes (10 screens, 56 files).
- **Real browser (headless Chromium), export + the fallback rule:** for a real business address, each of the 5 screens returns 200, keeps the real address, shows 5 tabs that all use the real id (none the placeholder), marks the right tab current, no page errors; a malformed id and the placeholder show no tabs. The same test on the normal `next start` build gives identical results (no regression).

## Notes and limits
- Not shown: sign-in or any API call from a bundled page (no shell yet; the API origin question Q3 is separate and is NOT part of Phase W2).
- The Capacitor local server's own fallback setting is **not verified** (no Android build yet); the rule above is what it must do.
- **Environment note (found while testing):** in the working copy used for this session, a Next build tried to add `@types/node` to `package.json` and the lockfile by itself, because that copy's `node_modules` had been left in a state where the package was not resolvable. A pristine checkout does not do this (CI is unaffected), and no dependency was added. Anyone who sees `package.json` or `pnpm-lock.yaml` change after a build should discard that change and reinstall from the lockfile.
