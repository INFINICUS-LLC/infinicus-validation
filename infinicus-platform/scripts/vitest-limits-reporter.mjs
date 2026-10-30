/**
 * CI-STAB-03 R3: an OPT-IN vitest reporter that answers "how close was each test to its timeout?" from measurement, not impression.
 *
 * A test that times out in CI tells you only that it exceeded its limit. This reporter records, per test, the EFFECTIVE timeout vitest applied (the
 * default, a per-test argument, or a package config) next to the measured duration, and prints the tests that used a large share of their limit,
 * so a limit that is merely thin shows up before it fails and a genuine hang is distinguishable from a slow-but-finishing test.
 *
 * Nothing runs it by default and it changes no behavior. Use it next to the normal reporter:
 *   npx vitest run --reporter=default --reporter=../../scripts/vitest-limits-reporter.mjs
 * Optional environment: LIMITS_THRESHOLD (share of the limit, default 0.5), LIMITS_TOP (rows printed, default 15),
 *   LIMITS_OUT (append every test as a JSON line), LIMITS_PKG (label for the JSON lines; default: the directory name).
 */
import { appendFileSync } from 'node:fs';
import { basename } from 'node:path';

/** Rows whose duration used at least `threshold` of their limit, tightest first. Pure; unit-tested. */
export function nearLimit(rows, threshold = 0.5, top = 15) {
  return rows
    .filter((r) => r.timeout > 0 && r.ms / r.timeout >= threshold)
    .map((r) => ({ ...r, share: r.ms / r.timeout }))
    .sort((a, b) => b.share - a.share)
    .slice(0, top);
}

export function formatNearLimit(rows, label) {
  if (rows.length === 0) return `[limits] ${label}: no test used a large share of its timeout`;
  const lines = rows.map((r) => `  ${String(Math.round(r.share * 100)).padStart(4)}%  ${String(r.ms).padStart(7)} ms of ${String(r.timeout).padStart(7)} ms  ${r.file}  ${r.name}`);
  return [`[limits] ${label}: tests above the threshold share of their timeout (tightest first):`, ...lines].join('\n');
}

export default class LimitsReporter {
  onInit(ctx) {
    this.root = ctx.config.root;
    this.label = process.env.LIMITS_PKG || basename(ctx.config.root);
    this.out = process.env.LIMITS_OUT || null;
    this.threshold = Number(process.env.LIMITS_THRESHOLD ?? 0.5);
    this.top = Number(process.env.LIMITS_TOP ?? 15);
  }

  onTestRunEnd(testModules = []) {
    const rows = [];
    for (const mod of testModules) {
      for (const tc of mod.children.allTests()) {
        rows.push({
          pkg: this.label,
          file: String(mod.moduleId).replace(`${this.root}/`, ''),
          name: tc.fullName.slice(-110),
          timeout: tc.options?.timeout ?? null,
          ms: Math.round(tc.diagnostic?.()?.duration ?? 0),
          state: tc.result?.().state ?? 'unknown',
        });
      }
    }
    if (this.out) for (const r of rows) appendFileSync(this.out, `${JSON.stringify(r)}\n`);
    console.error(formatNearLimit(nearLimit(rows, this.threshold, this.top), this.label));
  }
}
