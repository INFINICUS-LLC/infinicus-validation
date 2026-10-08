# Cloudflare Pages public output (legacy site)

Status: PR-A of the pre-launch security programme. Build tooling only: no application logic, API contract, schema, migration, Stack B code or Cloudflare setting changes.

## Purpose
The legacy site (static pages, 7 browser layer bundles, localisation files and `functions/` Pages Functions) was published straight from the repository root. Publishing the root exposes every tracked file: Stack B source and migrations, architecture docs, `.claude/` build state, `schema.sql`, `wrangler.toml`, archives, scripts and the Functions source. This change builds a minimal `dist/` from an explicit allowlist so only intended public assets are served.

## Architecture
```
public-manifest.json ──► scripts/build-public.mjs ──► dist/            (Pages "output directory")
 (allowlist, deny rules,    validates, then copies    37 declared files + generated _headers + _routes.json
  headers, routes)          byte-for-byte
functions/  (repo root, NOT in dist) ──► Pages compiles it separately into the Functions worker
```
- Allowlist, not blocklist: a file is public only if it is listed in `public-manifest.json`. Everything else is internal by default.
- Build fails (and writes nothing) if: a listed file is missing, unsafe, a symlink, duplicated, unsorted or matches a deny rule; a published file references a repo file that is not declared; a reference points nowhere (other than the one documented `sw.js` case); a language file exists that is not declared; the Functions routes are not covered by `_routes.json`; the output contains anything undeclared.
- Deterministic: same inputs give the same tree digest (printed by the build).

## Files
| File | Role |
|---|---|
| `public-manifest.json` | The allowlist (37 files), deny rules, header and routing configuration, documented known-missing references |
| `scripts/build-public.mjs` | Validator and builder (no dependencies; Node 18+). `--check` validates only; `--compare-routes F` compares with wrangler |
| `scripts/tests/build-public.test.mjs` | 31 tests (`node --test scripts/tests/build-public.test.mjs`) |
| `.github/workflows/public-output.yml` | Path-filtered CI: tests, build, `npm ci`, wrangler Functions compile, route comparison, existing bundle/platform checks |
| `package-lock.json` | Locks the only dependency (`@anthropic-ai/sdk` 0.39.0, used by `functions/api/simulate.js`) |
| `functions/_routes.json` | Removed: Pages reads `_routes.json` only from the output directory, and it was not a route. Build output was identical with and without it |
| `_routes.json` (repo root) | Unchanged; identical to the generated `dist/_routes.json` (a test enforces this) |

## Public set (37 files)
`index.html`, `landing.html`, `account.html`, `legal.html`, `theme.js`, `i18n.js`, `i18n/<code>.js` (19), the 7 layer bundles (`*/*-bundle.js`), `platform/platform-bootstrap.js`, `manifest.json`, `infinicus-mark.svg`, `og-image.svg`, `infinicus logo.jpeg`. Generated: `_headers`, `_routes.json`.

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
- With no `404.html`, Pages treats the project as a single-page app: an unknown path (including every excluded file) returns `index.html` with status 200, not 404. Excluded files are not exposed, but they do not 404. Adding a `404.html` is a publication decision left to the owner.
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
```

## Not in scope (later blocks)
Authentication and authorization (`/api/business/*`, `nurture-batch`, `simulate`, `send-email`), CORS, email behaviour, Turnstile, `_headers` CSP, secrets, bindings, D1 verification, domain and DNS. Stack B, SOT-02 boundaries and the frozen architecture are unchanged.
