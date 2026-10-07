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
// Usage: node check-dependency-vulnerabilities.mjs
// Exit code: 0 if every finding is allowlisted; 1 otherwise (with a
// printed list of the un-allowlisted findings).

import { spawnSync } from 'node:child_process';

const ALLOWLIST = [
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

  // Temporary Vitest/Tinypool compatibility exceptions.
  // Repository-wide tracked-source and package-manifest searches
  // confirm INFINICUS does not import, invoke, or declare tinypool
  // directly. tinypool is present only as a transitive dependency of
  // vitest@1.6.1 and is not part of the production API or web runtime.
  // These entries must be removed when the dedicated Vitest/Vite
  // security migration is completed.
  {
    githubAdvisoryId: 'GHSA-5gmw-xhrv-c9v3',
    package: 'tinypool',
    reason:
      'Transitive dependency of vitest@1.6.1 only. Repository-wide tracked-source and package-manifest searches confirm INFINICUS does not import, invoke, or declare tinypool directly. Vitest is used only as a development/test dependency via `vitest run`; tinypool is not shipped or invoked by the production API or web runtime. Temporary exception pending a dedicated Vitest/Vite migration.',
  },
  {
    githubAdvisoryId: 'GHSA-85c8-ppgw-ccpr',
    package: 'tinypool',
    reason:
      'Transitive dependency of vitest@1.6.1 only. Repository-wide tracked-source and package-manifest searches confirm INFINICUS does not import, invoke, or declare tinypool directly. Vitest is used only as a development/test dependency via `vitest run`; tinypool is not shipped or invoked by the production API or web runtime. Temporary exception pending a dedicated Vitest/Vite migration.',
  },
];

function main() {
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

  if (advisories.length === 0) {
    console.log('Dependency scan passed — 0 advisories found.');
    return;
  }

  const allowlistIds = new Set(
    ALLOWLIST.map((entry) => entry.githubAdvisoryId),
  );

  const unallowlisted = advisories.filter(
    (advisory) => !allowlistIds.has(advisory.github_advisory_id),
  );

  const allowlisted = advisories.filter((advisory) =>
    allowlistIds.has(advisory.github_advisory_id),
  );

  for (const advisory of allowlisted) {
    const entry = ALLOWLIST.find(
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

  console.log(
    `\nDependency scan passed — ${allowlisted.length} advisory(ies), ` +
      'all allowlisted with a documented reason.',
  );
}

main();