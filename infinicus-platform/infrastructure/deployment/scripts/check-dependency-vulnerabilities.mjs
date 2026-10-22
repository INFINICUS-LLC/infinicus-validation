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
