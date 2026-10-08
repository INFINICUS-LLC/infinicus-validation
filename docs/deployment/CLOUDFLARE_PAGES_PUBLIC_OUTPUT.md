# Cloudflare Pages public output (legacy site)

Status: PR-A of the pre-launch security programme. Build tooling only: no application logic, API contract, schema, migration, Stack B code or Cloudflare setting changes.

## Purpose
The legacy site (static pages, 7 browser layer bundles, localisation files and `functions/` Pages Functions) was published straight from the repository root. Publishing the root exposes every tracked file: Stack B source and migrations, architecture docs, `.claude/` build state, `schema.sql`, `wrangler.toml`, archives, scripts and the Functions source. This change builds a minimal `dist/` from an explicit allowlist so only intended public assets are served.

## Architecture
```
public-manifest.json ──► scripts/build-public.mjs ──► dist/            (Pages "output directory")
 (allowlist, deny rules,    validates, then copies    38 declared files + generated _headers + _routes.json
  headers, routes)          byte-for-byte
functions/  (repo root, NOT in dist) ──► Pages compiles it separately into the Functions worker
```
- Allowlist, not blocklist: a file is public only if it is listed in `public-manifest.json`. Everything else is internal by default.
- Build fails (and writes nothing) if: a listed file is missing, unsafe, a symlink, duplicated, unsorted or matches a deny rule; a published file references a repo file that is not declared; a reference points nowhere (other than the one documented `sw.js` case); a language file exists that is not declared; the Functions routes are not covered by `_routes.json`; the output contains anything undeclared.
- Deterministic: same inputs give the same tree digest (printed by the build).

## Files
| File | Role |
|---|---|
| `public-manifest.json` | The allowlist (38 files), deny rules, header and routing configuration, documented known-missing references |
| `scripts/build-public.mjs` | Validator and builder (no dependencies; Node 18+). `--check` validates only; `--compare-routes F` compares with wrangler |
| `scripts/tests/build-public.test.mjs` | 40 tests (`node --test scripts/tests/build-public.test.mjs`) |
| `scripts/tests/public-output-http.test.mjs` | 5 HTTP tests against the real Pages runtime: published paths 200, every excluded or unknown path a genuine 404, headers served, Functions in front and default-deny families still 404 |
| `404.html` | The only addition to the public set after the first review: a minimal, script-free page so unknown paths return a genuine 404 |
| `.github/workflows/public-output.yml` | Path-filtered CI: tests, build, `npm ci`, wrangler Functions compile, route comparison, existing bundle/platform checks |
| `package-lock.json` | Locks the only dependency (`@anthropic-ai/sdk` 0.39.0, used by `functions/api/simulate.js`) |
| `functions/_routes.json` | Removed: Pages reads `_routes.json` only from the output directory, and it was not a route. Build output was identical with and without it |
| `_routes.json` (repo root) | Unchanged; identical to the generated `dist/_routes.json` (a test enforces this) |

## Public set (38 files)
`404.html`, `index.html`, `landing.html`, `account.html`, `legal.html`, `theme.js`, `i18n.js`, `i18n/<code>.js` (19), the 7 layer bundles (`*/*-bundle.js`), `platform/platform-bootstrap.js`, `manifest.json`, `infinicus-mark.svg`, `og-image.svg`, `infinicus logo.jpeg`. Generated: `_headers`, `_routes.json`.

## Internal by default (not published)
`bol.html`, `dal.html`, `pitch deck.html`, `pitch deck_files/`, `icon.svg` (unreferenced), `docs/`, `.claude/`, `.github/`, `infinicus-platform/` (Stack B), the layer directories apart from their bundle, `functions/`, `schema.sql`, `wrangler.toml`, `package*.json`, `*.bat`, `scripts/`, `templates/`, `platform/tests/`, both `.zip` archives, `QUEUE-INTEGRITY-SHA256.json`, `CLAUDE-*.md`, `INSTALL-INTO-REPOSITORY.md`, `gate.txt`, `CNAME`.

## Generated configuration
- `_headers`: `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: SAMEORIGIN`, `Permissions-Policy` (camera, microphone, geolocation, payment, usb disabled; none are used by the site). `_headers` applies to static assets only, not to Functions responses; Functions headers belong to the Function code (PR-B/C).
- `_routes.json`: `include ["/api/*"]`, `exclude ["/api/_shared/*"]`, identical to the existing contract. All 21 Functions routes are covered.

## Dashboard settings for the NEW Pages project (not changed by this PR)
| Setting | Value |
|---|---|
| Production branch | decided later; keep production off `main` until the API gates are closed |
| Build command | `node scripts/build-public.mjs` |
| Build output directory | `dist` |
| Root directory | `/` (repository root; `functions/` must stay here) |
| Environment variable | `NODE_VERSION=22` |
| Framework preset | None |
Bindings, secrets and the custom domain are configured separately. The original account keeps publishing the repository root until its owner changes it; nothing here touches it. Rollback in the new project: set the output directory back to `/`.

## Behaviour to know
- `404.html` is published (and required by the manifest check). Pages therefore answers every unknown or excluded path with HTTP 404 and that page, instead of the single-page-app fallback that would return `index.html` with 200. Verified over HTTP by `public-output-http.test.mjs` against `wrangler pages dev`. Static assets answer only GET/HEAD, so a POST to a path that has no Function is refused (405), never executed.
- `landing.html`, `account.html`, `legal.html` are served at clean URLs (a 308 from the `.html` path); this is Pages behaviour and unchanged.
- Known pre-existing issue: `index.html` and `landing.html` register `/sw.js`, which does not exist (`i18n/sw.js` is the Swahili language file). The error is caught by the pages; recorded in the manifest, not changed here.
- `dist/` is a build artifact. The repository has no root `.gitignore`; do not commit `dist/`.

## Adding a public asset
Publication needs explicit approval. Add the path to `public-manifest.json` (sorted), keep it out of the deny rules, run the tests, and state the reason in the PR. A referenced-but-undeclared file fails the build by design.

## Verification
```
node --test scripts/tests/build-public.test.mjs
node scripts/build-public.mjs
npm ci --ignore-scripts
npx wrangler@3.114.17 pages functions build functions --outfile /tmp/_worker.js --output-routes-path /tmp/routes.json
node scripts/build-public.mjs --compare-routes /tmp/routes.json
PUBLIC_OUTPUT_HTTP=required node --test scripts/tests/public-output-http.test.mjs
```

## Not in scope (later blocks)
Authentication and authorization (`/api/business/*`, `nurture-batch`, `simulate`, `send-email`), CORS, email behaviour, Turnstile, `_headers` CSP, secrets, bindings, D1 verification, domain and DNS. Stack B, SOT-02 boundaries and the frozen architecture are unchanged.

## Middleware-protected route families
A `_middleware.js` that exports an `onRequest` handler (including the export-list form `export { onRequest }`) guards its directory and everything below it, and Wrangler reports that family as one wildcard route (for example `/api/business/*`) instead of one route per file. `build-public.mjs` models exactly that:
- `discoverFunctionRoutes` lists handler files (middleware files and handler names that appear only in comments are not routes); `discoverMiddlewareFamilies` lists the guarded families; `effectiveFunctionRoutes` collapses routes under a family into the family wildcard, outermost family first.
- `--compare-routes` compares the effective routes with Wrangler's list **and** proves the generated `_routes.json` sends every Wrangler route to Functions and excludes none of them, so a guarded family can never fall through to a static path.
- A `_middleware` file that exports no handler is a build failure: it would guard nothing and give false assurance.
- Fail-closed behaviour is not weakened: the middleware itself (default-deny 404 unless the family flag is exactly `enabled`) is unchanged; this tooling only validates it.
