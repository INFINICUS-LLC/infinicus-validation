# GitHub Pages exposure report and remediation options

Status: option 1 implemented in this change (inert until you opt in). Options 2 and 3 are owner actions. Nothing in either Cloudflare account or any repository setting was changed by this work.

## 1. Finding
GitHub Pages for `INFINICUS-LLC/infinicus-validation` is live and publishes the **entire repository root** of `main`.

Evidence (owner screenshots of Settings -> Pages, 2026-10-08):
- "Your site is live at http://infini-cus.com/", last deployed by `katohuzairu122-png` minutes after the #56 merge.
- Build and deployment: Source = "Deploy from a branch", branch `main`, folder `/ (root)`.
- Custom domain `infini-cus.com`, "DNS Check in Progress"; "Enforce HTTPS" unavailable (the domain is not configured for GitHub's HTTPS).
- Visibility: public site (private publishing is a GitHub Enterprise feature that is not enabled).
- The `main` workflow list shows a "pages build and deployment" run on every push.

Because the folder is `/ (root)`, every tracked file is published: `schema.sql`, `wrangler.toml` (now containing the new account's KV and D1 identifiers from #51), `docs/`, `.claude/`, `infinicus-platform/` (Stack B source and 175 migrations), `functions/` source, `scripts/`, `templates/`, both `.zip` archives, `package.json`, `push.bat` and the rest. The Cloudflare allowlist from PR #52 does not apply to this path.

## 2. What is and is not known
| Known | Not known (cannot be checked from the build environment) |
|---|---|
| GitHub Pages is enabled with the root as source | Where `infini-cus.com` is actually served from. DNS resolves to Cloudflare addresses, not GitHub's, so the domain is either Cloudflare in front of GitHub Pages or a Cloudflare Pages project in the **original** account that also serves the repo root |
| No credentials were found in the tracked files (pattern scan); the Supabase key in `index.html` is a publishable key | The repository visibility. If the repository is public, these files were already readable on GitHub and Pages adds convenience, not new access. If it is private, Pages is the leak |
| `functions/` never runs on GitHub Pages (static only), so `/api/*` calls fail on that host | Whether anyone has fetched the files (no access logs here) |

Quick check for the owner: open `https://infini-cus.com/schema.sql` in a browser. If the SQL downloads or shows, the exposure is confirmed on the live domain. Also check Settings -> General for repository visibility.

## 3. Options
### Option 1 (implemented): publish only the allowlisted files from GitHub Pages
A workflow (`.github/workflows/github-pages.yml`) stages exactly the 38 files in `public-manifest.json` (including `404.html`, excluding the Cloudflare-only `_headers` and `_routes.json` and `CNAME`) and deploys only that artifact. Everything else is never uploaded; unknown paths return a genuine 404.
- Effort: merge this PR, set one repository variable, change one Pages setting, run the workflow once.
- Visitor impact: none. The site content is the same files; `/api/*` never worked on this host.
- Risks: a short gap if the first Actions deployment has not finished after the source switch (run the workflow immediately); the custom domain is expected to persist as a repository setting after the switch (about 85% sure; re-enter `infini-cus.com` if it does not); pages that were reachable by accident (for example `/docs/...`) now 404 by design.
- What it does not do: it does not touch the Cloudflare project that may also publish the root (option 3) and does not remove previously published content from caches or from git history.

### Option 2: unpublish GitHub Pages
Settings -> Pages -> Unpublish site. Immediate and reversible.
- Use when the live site is served only from Cloudflare and GitHub Pages is no longer needed.
- Risk: if `infini-cus.com` currently depends on GitHub Pages as its origin, the site goes down. Confirm the serving path first.
- Combine with option 1 only if you want a controlled static mirror; otherwise pick one.

### Option 3: restrict the original Cloudflare project (owner action in the original account)
In the original project's settings: build command `node scripts/build-public.mjs`, output directory `dist`. Then it serves the same allowlist with a genuine 404 page. This is the Cloudflare half of the same fix; this work did not touch that account.
- Risk: build settings are per project; set `NODE_VERSION=22`. Roll back by setting the output directory back to the repository root.

### Baseline: do nothing
Leaves every tracked file published on every push. Not recommended.

## 4. Recommendation
Do option 1 now (it is safe and inert until opt-in), confirm the serving path, then do option 3 for the original Cloudflare project, and use option 2 only if GitHub Pages turns out to be unused. Separately decide whether the repository itself should be private.

## 5. Rollout for option 1 (in order)
1. Merge this PR. The workflow runs on `main` in stage-only mode; the built-in branch deployment keeps working unchanged.
2. Settings -> Secrets and variables -> Actions -> Variables: create `PAGES_DEPLOY_FROM_ACTIONS` = `true`.
3. Settings -> Pages -> Build and deployment -> Source: choose **GitHub Actions**.
4. Actions -> "GitHub Pages (published files only)" -> Run workflow (branch `main`). Wait for the `deploy` job to finish.
5. Verify (section 7). Confirm the custom domain is still `infini-cus.com`.

## 6. Rollback
- Fastest: Settings -> Pages -> Source back to "Deploy from a branch", `main`, `/ (root)` (this re-publishes the whole root, so use only if the site is broken).
- Or set the variable `PAGES_DEPLOY_FROM_ACTIONS` to anything other than `true` to stop Actions deployments (the last deployment stays live).
- The workflow is additive; reverting this PR removes it.

## 7. Verification checklist (owner, read-only)
After step 4, each of these should be HTTP 404, and the first four were published before:
`/schema.sql`, `/wrangler.toml`, `/docs/architecture/ROOT-CLAUDE-REFERENCE.md`, `/infinicus-platform/package.json`, `/package.json`, `/bol.html`, `/pitch%20deck.html`, `/does-not-exist`.
These should be HTTP 200: `/`, `/landing`, `/account`, `/legal`, `/theme.js`, `/i18n/zh.js`, `/manifest.json`, `/og-image.svg`.
Also: the Actions run shows "Show exactly what would be published" listing 38 files.

## 8. Residual risks after option 1
- Files already published remain in search caches, archives and git history; there are no credentials to rotate, but the KV/D1 identifiers in `wrangler.toml` and the full Stack B source were visible. If the repository is private, treat that period as an exposure window.
- Repository visibility is not changed by any option here.
- Original Cloudflare project (option 3) and the three PR #54 decisions remain open.

## 9. Tests added
`scripts/tests/github-pages.test.mjs` (staged set equals the manifest exactly and is byte-identical; no Cloudflare-only or internal files; deterministic; refuses unsafe targets; inherits the allowlist checks; workflow uploads only the staged directory, deploys only from `main` and only after opt-in, has least-privilege permissions and pinned actions) plus the existing allowlist tests.
