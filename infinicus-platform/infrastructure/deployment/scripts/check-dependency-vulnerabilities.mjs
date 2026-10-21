#!/usr/bin/env node
// BUILD-26 — Dependency scanning gate (spec §2). Runs the real `pnpm
// audit` against the npm advisory database and fails the build on any
// advisory not explicitly allowlisted below — each entry requires a
// justification, not a blanket suppression. `pnpm audit`'s own
// `pnpm.auditConfig.ignoreCves` (package.json) only matches
// CVE-numbered advisories; sharp's advisory here has no assigned CVE
// (GHSA-only), so it can't be allowlisted that way — this script
// matches on the advisory's github_advisory_id instead, precisely.
//
// Usage: node check-dependency-vulnerabilities.mjs [--allowlist-only]
// Exit code: 0 if every finding is allowlisted and no allowlist entry has
// expired; 1 otherwise (with a printed list of the problems).
//
// CI-HEALTH-1: a TEMPORARY entry must carry `expires` (YYYY-MM-DD, the
// "review by" date, inclusive). From the day after, the entry no longer
// allowlists anything and the check fails, so a time-boxed risk acceptance
// cannot silently become permanent policy. `--allowlist-only` validates the
// allowlist itself (no network, no `pnpm audit`) so the compliance result is
// deterministic and visible even when the audit step cannot reach the
// registry. The date is the real UTC date; there is deliberately no way to
// override it from the command line or the environment.

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const ALLOWLIST = [
  {
    githubAdvisoryId: 'GHSA-5xrq-8626-4rwp',
    package: 'vitest',
    reason:
      'Requires the Vitest UI server (`vitest --ui`) to be actively listening. Every test script in this monorepo runs `vitest run` — the UI server is never started, in any package, in CI, or in local development, so the vulnerable code path is unreachable. Verified via grep across every package.json\'s "test" script.',
  },
  {
    githubAdvisoryId: 'GHSA-f88m-g3jw-g9cj',
    package: 'sharp',
    reason:
      'Transitive dependency of Next.js\'s built-in image-optimization component (next/image). apps/web never imports next/image (verified via grep) — no code path in this repository invokes sharp/libvips, so the vulnerable image-processing routines are never executed.',
  },
  {
    githubAdvisoryId: 'GHSA-rgj7-g3m4-5g8c',
    package: 'sharp',
    reason:
      'Transitive dependency of Next.js image optimization. apps/web does not import or render next/image and does not expose an image-optimization upload/processing path, so untrusted input cannot reach sharp/libheif in this repository. Next.js itself is upgraded to the patched 15.5.x line; this exception is limited to the otherwise unreachable transitive sharp advisory.',
  },

  // BUILD-30 launch-acceptance findings:
  // esbuild and vite are transitive dependencies of vitest.
  {
    githubAdvisoryId: 'GHSA-67mh-4wv8-2f99',
    package: 'esbuild',
    reason:
      'esbuild\'s own development server (`esbuild --serve`) can be queried cross-origin. Never started in this repository — esbuild is used only as vitest\'s internal bundler for `vitest run`, never via its own CLI/serve mode.',
  },
  {
    githubAdvisoryId: 'GHSA-4w7w-66w2-5vf9',
    package: 'vite',
    reason:
      'Path traversal in vite dev server\'s handling of optimized-dependency `.map` files. Requires `vite dev` or `vite preview` to be running; this repository never starts vite\'s own development or preview server.',
  },
  {
    githubAdvisoryId: 'GHSA-v6wh-96g9-6wx3',
    package: 'vite',
    reason:
      'NTLMv2 hash disclosure via UNC path handling in vite\'s `launch-editor` development-server integration. No vite development server is started in this repository, so the vulnerable route is unreachable.',
  },
  {
    githubAdvisoryId: 'GHSA-fx2h-pf6j-xcff',
    package: 'vite',
    reason:
      'Vite development server `server.fs.deny` bypass through Windows alternate paths. No vite development server is started in this repository, so the vulnerable route is unreachable.',
  },

  // ── TEMPORARY exceptions: tinypool (tracked in issue #24) ─────────────────
  // dev/test-only. tinypool@0.8.4 is a transitive dependency of vitest@1.6.1
  // (the `vitest run` test runner declared by the workspace packages). No
  // INFINICUS code declares, imports or calls tinypool, and it is not part of
  // the production API or web runtime. This is a time-boxed risk acceptance,
  // NOT permanent CI policy: remove both entries when the vitest/vite
  // toolchain is upgraded. Tracking issue:
  // https://github.com/INFINICUS-LLC/infinicus-validation/issues/24
  // Review/removal target date: 2026-10-01.
  {
    githubAdvisoryId: 'GHSA-5gmw-xhrv-c9v3',
    package: 'tinypool',
    expires: '2026-10-01',
    reason:
      'TEMPORARY (issue #24, review by 2026-10-01). Dev/test-only transitive dependency of vitest@1.6.1; not declared, imported or invoked by INFINICUS code and not shipped in the production API or web runtime. Remove when the vitest/vite toolchain is upgraded.',
  },
  {
    githubAdvisoryId: 'GHSA-85c8-ppgw-ccpr',
    package: 'tinypool',
    expires: '2026-10-01',
    reason:
      'TEMPORARY (issue #24, review by 2026-10-01). Dev/test-only transitive dependency of vitest@1.6.1; not declared, imported or invoked by INFINICUS code and not shipped in the production API or web runtime. Remove when the vitest/vite toolchain is upgraded.',
  },

  // ── TEMPORARY exceptions: vite / launch-editor (2026-10-21, tracked in issue #24) ─────────────────
  // Three advisories published after the entries above, found failing the CI dependency scan on main (which skips the migration gate, tests and image
  // build when this step fails). Same reasoning and same time box as the tinypool entries: dev/test toolchain only, unreachable, upgrade with vitest.
  // Time-boxed risk acceptance, NOT permanent CI policy.
  {
    githubAdvisoryId: 'GHSA-698v-4r3x-3vcv',
    package: 'vite',
    expires: '2026-10-01',
    reason:
      'TEMPORARY (issue #24, review by 2026-10-01). launch-editor `escapeCmdArgs()` omits % escaping on Windows (moderate); only relevant to the open-in-editor route of the vite dev server, and only on Windows. vite@5.4.21 is only a transitive dependency of vitest@1.6.1 (declared as a devDependency by workspace packages; vite itself is declared nowhere). Nothing here starts a vite server (no vite, vite dev or vite preview script, no vitest --ui, none in CI or the Dockerfiles), so the launch-editor integration that this advisory concerns is never loaded. The files are present in the API image because it installs the workspace with its devDependencies, but they are never executed. The fix needs vite >= 6.4.4, a major upgrade that belongs with the vitest upgrade tracked in issue #24. Remove when the vitest/vite toolchain is upgraded.',
  },
  {
    githubAdvisoryId: 'GHSA-r825-w8mm-5pxw',
    package: 'vite',
    expires: '2026-10-01',
    reason:
      'TEMPORARY (issue #24, review by 2026-10-01). launch-editor editor CLI flag misinterpretation (moderate); only relevant to the open-in-editor route of the vite dev server. vite@5.4.21 is only a transitive dependency of vitest@1.6.1 (declared as a devDependency by workspace packages; vite itself is declared nowhere). Nothing here starts a vite server (no vite, vite dev or vite preview script, no vitest --ui, none in CI or the Dockerfiles), so the launch-editor integration that this advisory concerns is never loaded. The files are present in the API image because it installs the workspace with its devDependencies, but they are never executed. The fix needs vite >= 6.4.4, a major upgrade that belongs with the vitest upgrade tracked in issue #24. Remove when the vitest/vite toolchain is upgraded.',
  },
  {
    githubAdvisoryId: 'GHSA-587h-7wmj-h5pm',
    package: 'vite',
    expires: '2026-10-01',
    reason:
      'TEMPORARY (issue #24, review by 2026-10-01). launch-editor `fs.existsSync()` existence check bypass on Windows (high); only relevant to the open-in-editor route of the vite dev server, and only on Windows. vite@5.4.21 is only a transitive dependency of vitest@1.6.1 (declared as a devDependency by workspace packages; vite itself is declared nowhere). Nothing here starts a vite server (no vite, vite dev or vite preview script, no vitest --ui, none in CI or the Dockerfiles), so the launch-editor integration that this advisory concerns is never loaded. The files are present in the API image because it installs the workspace with its devDependencies, but they are never executed. The fix needs vite >= 6.4.4, a major upgrade that belongs with the vitest upgrade tracked in issue #24. Remove when the vitest/vite toolchain is upgraded.',
  },
];

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function todayUtc(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function isRealDate(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Pure: checks the allowlist itself against a UTC date (YYYY-MM-DD).
 * `expired`: TEMPORARY entries whose review-by date has passed (the date itself is still valid).
 * `invalid`: structural problems (missing/malformed expiry on a TEMPORARY entry, expiry not stated in the reason, duplicate advisory ids).
 * `active`: the entries that may allowlist an advisory today (everything except `expired`).
 */
export function evaluateAllowlist(allowlist, today) {
  if (!isRealDate(today)) throw new Error(`today must be a real YYYY-MM-DD date, got ${String(today)}`);
  const expired = [];
  const invalid = [];
  const active = [];
  const seen = new Set();
  for (const entry of allowlist) {
    const id = entry.githubAdvisoryId;
    if (seen.has(id)) invalid.push({ entry, problem: `duplicate allowlist entry for ${id}` });
    seen.add(id);
    const temporary = typeof entry.reason === 'string' && entry.reason.startsWith('TEMPORARY');
    if (entry.expires === undefined) {
      if (temporary) invalid.push({ entry, problem: `${id} is TEMPORARY but has no 'expires' date` });
      active.push(entry);
      continue;
    }
    if (!isRealDate(entry.expires)) {
      invalid.push({ entry, problem: `${id} has an invalid 'expires' (${String(entry.expires)}); expected a real YYYY-MM-DD date` });
      continue;
    }
    if (temporary && !entry.reason.includes(entry.expires)) {
      invalid.push({ entry, problem: `${id}: the reason must state the same review-by date as 'expires' (${entry.expires})` });
    }
    if (entry.expires < today) expired.push(entry);
    else active.push(entry);
  }
  return { expired, invalid, active };
}

/** Pure: splits audit advisories by whether an ACTIVE (unexpired) allowlist entry covers them. */
export function classifyAdvisories(advisories, active) {
  const ids = new Set(active.map((entry) => entry.githubAdvisoryId));
  return {
    allowlisted: advisories.filter((a) => ids.has(a.github_advisory_id)),
    unallowlisted: advisories.filter((a) => !ids.has(a.github_advisory_id)),
  };
}

function reportAllowlistProblems({ expired, invalid }, today) {
  for (const { problem } of invalid) console.error(`ALLOWLIST INVALID: ${problem}`);
  for (const entry of expired) {
    console.error(
      `ALLOWLIST EXPIRED: ${entry.package} (${entry.githubAdvisoryId}) expired on ${entry.expires} (today is ${today} UTC). ` +
        'Remove the entry after upgrading (issue #24), or have the owner renew it with a new, justified date.',
    );
  }
  return expired.length + invalid.length;
}

function main() {
  const today = todayUtc();
  const state = evaluateAllowlist(ALLOWLIST, today);
  const allowlistProblems = reportAllowlistProblems(state, today);

  if (process.argv.includes('--allowlist-only')) {
    if (allowlistProblems > 0) {
      console.error(`\nAllowlist compliance FAILED — ${allowlistProblems} problem(s).`);
      process.exit(1);
    }
    console.log(`Allowlist compliance passed — ${state.active.length} entries, none expired (UTC ${today}).`);
    return;
  }

  let auditResult;

  if (process.platform === 'win32') {
    auditResult = spawnSync(
      process.env.ComSpec ?? 'cmd.exe',
      ['/d', '/s', '/c', 'pnpm audit --json'],
      {
        encoding: 'utf8',
      },
    );
  } else {
    auditResult = spawnSync('pnpm', ['audit', '--json'], {
      encoding: 'utf8',
    });
  }

  if (auditResult.error) {
    console.error(
      `ERROR: failed to run pnpm audit: ${auditResult.error.message}`,
    );
    process.exit(1);
  }

  const auditJson = auditResult.stdout;

  if (!auditJson || auditJson.trim().length === 0) {
    const stderr = auditResult.stderr?.trim();

    if (stderr) {
      console.error(`ERROR: pnpm audit produced no output:\n${stderr}`);
    } else {
      console.error('ERROR: pnpm audit produced no output.');
    }

    process.exit(1);
  }

  let report;

  try {
    report = JSON.parse(auditJson);
  } catch (error) {
    console.error(
      `ERROR: pnpm audit returned invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exit(1);
  }

  const advisories = Object.values(report.advisories ?? {});

  const { allowlisted, unallowlisted } = classifyAdvisories(advisories, state.active);

  if (advisories.length === 0) {
    if (allowlistProblems > 0) {
      console.error(`\nDependency scan FAILED — ${allowlistProblems} allowlist problem(s).`);
      process.exit(1);
    }
    console.log('Dependency scan passed — 0 advisories found.');
    return;
  }

  for (const advisory of allowlisted) {
    const entry = state.active.find(
      (candidate) =>
        candidate.githubAdvisoryId === advisory.github_advisory_id,
    );

    console.log(
      `ALLOWLISTED: [${advisory.severity}] ${advisory.module_name} ` +
        `(${advisory.github_advisory_id}) — ${entry.reason}`,
    );
  }

  if (unallowlisted.length > 0) {
    console.error(
      `\nDependency scan FAILED — ${unallowlisted.length} ` +
        'un-allowlisted advisory(ies):',
    );

    for (const advisory of unallowlisted) {
      console.error(
        `  - [${advisory.severity}] ${advisory.module_name} ` +
          `(${advisory.github_advisory_id}): ${advisory.title}`,
      );
    }

    console.error(
      '\nEither upgrade the affected package, or add a justified entry ' +
        'to ALLOWLIST in this script.',
    );

    process.exit(1);
  }

  if (allowlistProblems > 0) {
    console.error(`\nDependency scan FAILED — ${allowlistProblems} allowlist problem(s) (see above).`);
    process.exit(1);
  }

  console.log(
    `\nDependency scan passed — ${allowlisted.length} advisory(ies), ` +
      'all allowlisted with a documented reason.',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
