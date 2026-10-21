/**
 * OM-EVID-1 architecture guard (no database): the older, human-entered observation path and the OM -> CL feedback machinery.
 *
 * Section XI: nothing may produce a "verified" outcome without authoritative evidence. The observation lifecycle predates P0-6d and has a `verified`
 * status plus an OM -> CL hand-off, none of which is wired to execution evidence or to the learning gate. They are dormant: no production code calls
 * them. This guard pins that fact so that wiring any of it later is a deliberate, reviewed change (it must update this test and go through the gate).
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const PLATFORM = resolve(__dirname, '../../..');
const SKIP = new Set(['node_modules', 'dist', '.turbo', '.next', 'coverage']);
function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) yield full;
  }
}
const isTest = (rel: string): boolean => /(^|\/)(tests?|__tests__)\//.test(rel) || /\.test\.[tj]sx?$/.test(rel);
const stripComments = (s: string): string => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const production: { rel: string; code: string }[] = [];
for (const root of ['apps', 'packages', 'layers']) {
  for (const file of walk(join(PLATFORM, root))) {
    const rel = relative(PLATFORM, file).split('\\').join('/');
    if (!isTest(rel)) production.push({ rel, code: stripComments(readFileSync(file, 'utf8')) });
  }
}
const DB_SRC = 'packages/database/src/';
const outsideDatabase = production.filter((f) => !f.rel.startsWith(DB_SRC));
const OBSERVATION_REPO = 'packages/database/src/repositories/om/OutcomeObservationRepository.ts';

describe('OM-EVID-1 legacy observation path', () => {
  it('scans the real production tree (not vacuous)', () => {
    expect(production.length).toBeGreaterThan(200);
    expect(production.find((f) => f.rel === OBSERVATION_REPO)?.code.length ?? 0).toBeGreaterThan(1000);
  });

  it('the observation repository is used by exactly the two workflow services', () => {
    const users = outsideDatabase.filter((f) => /\bOutcomeObservationRepository\b/.test(f.code)).map((f) => f.rel).sort();
    expect(users).toEqual(['packages/workflow/src/BusinessDecisionRecommendationService.ts', 'packages/workflow/src/DecisionWorkflowService.ts']);
  });

  it('no production code calls verify() or dispute() on an observation: the `verified` observation status is unreachable', () => {
    for (const f of outsideDatabase) {
      expect(f.code, f.rel).not.toMatch(/outcomeObservations?\s*\.\s*(verify|dispute|supersede)\s*\(/);
    }
    // the only production writer of the status column is the repository's own lifecycle
    const writers = production.filter((f) => /UPDATE\s+outcome_monitoring\.outcome_observations\s+SET\s+status/i.test(f.code)).map((f) => f.rel);
    expect(writers).toEqual([OBSERVATION_REPO]);
  });

  it('the workflow services only create, annotate, record and read observations (the human-entered path)', () => {
    for (const rel of ['packages/workflow/src/DecisionWorkflowService.ts', 'packages/workflow/src/BusinessDecisionRecommendationService.ts']) {
      const code = production.find((f) => f.rel === rel)!.code;
      const calls = new Set([...code.matchAll(/outcomeObservations\s*\.\s*(\w+)\s*\(/g)].map((m) => m[1]));
      for (const name of calls) expect(['createObservation', 'addMeasurement', 'addEvidence', 'record', 'listForBusiness', 'listLatestDecidedForActions'], `${rel}: ${name}`).toContain(name);
    }
  });

  it('the OM -> CL feedback machinery (reviews, feedback packages, OM publication) has no production caller outside the database package', () => {
    for (const f of outsideDatabase) {
      expect(f.code, f.rel).not.toMatch(/\b(LearningFeedbackPackageRepository|OutcomeReviewRepository|OMPublicationRepository)\b/);
    }
  });

  it('no production code outside the database package names a verified outcome state, and the learning gate is still uncalled', () => {
    const allowed = new Set(['packages/handoff-contracts/src/execution-evidence/states.ts']);
    for (const f of outsideDatabase) {
      if (allowed.has(f.rel)) continue;
      expect(f.code, f.rel).not.toMatch(/['"]OUTCOME_(VERIFIED|OBSERVED|FAILED)['"]/);
    }
    expect(production.filter((f) => /learningEligibility\(/.test(f.code) && !f.rel.endsWith('execution-evidence/states.ts')).map((f) => f.rel)).toEqual([]);
  });

  it('the recorded human outcome is shown to users as free text notes, never as a verified result', () => {
    const svc = production.find((f) => f.rel === 'packages/workflow/src/BusinessDecisionRecommendationService.ts')!.code;
    expect(svc).toMatch(/outcomeNotes/);
    expect(svc).not.toMatch(/outcomeVerified|isVerified|verifiedOutcome|effective:\s*true|worked:/);
  });
});
