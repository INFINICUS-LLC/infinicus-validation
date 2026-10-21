/**
 * CL-BOUNDARY-1 architecture guard (no database): every transition from Outcome Monitoring evidence into Control Loop learning passes through the
 * ONE learning gate, and there is no way around it.
 *
 *   learningEligibility (handoff-contracts, the gate)  <-  decideLearningRelease (handoff-contracts, the decision)  <-  LearningReleaseBoundary (OM runtime)  ->  sink
 *
 * Nothing else may decide learning, validate an OM -> CL hand-off, reach a Continuous Learning entry point, or construct the boundary. Learning is not
 * activated: nothing in production constructs the boundary or supplies a sink. Wiring it later is a deliberate change that must update this test.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const PLATFORM = resolve(__dirname, '../../..');
const SKIP = new Set(['node_modules', 'dist', '.turbo', '.next', 'coverage', 'out']);
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
const read = (rel: string): string => production.find((f) => f.rel === rel)?.code ?? '';
const users = (re: RegExp, except: string[] = []) => production.filter((f) => re.test(f.code) && !except.includes(f.rel)).map((f) => f.rel).sort();

const GATE = 'packages/handoff-contracts/src/execution-evidence/states.ts';
const DECISION = 'packages/handoff-contracts/src/om-to-cl-learning-release.ts';
const CONTRACT = 'packages/handoff-contracts/src/om-to-cl.ts';
const BOUNDARY = 'packages/outcome-monitoring-runtime/src/LearningReleaseBoundary.ts';
const DB_SRC = 'packages/database/src/';
const READER = 'packages/database/src/repositories/om/ActionExecutionVerificationRepository.ts';

describe('CL-BOUNDARY-1 - no way around the learning gate', () => {
  it('scans the real production tree (not vacuous)', () => {
    expect(production.length).toBeGreaterThan(200);
    for (const rel of [GATE, DECISION, CONTRACT, BOUNDARY, READER]) expect(read(rel).length, rel).toBeGreaterThan(300);
  });

  it('the chain is exactly gate <- decision <- boundary: each link has one production caller', () => {
    expect(users(/\blearningEligibility\(/, [GATE])).toEqual([DECISION]);
    expect(users(/\bdecideLearningRelease\(/, [DECISION])).toEqual([BOUNDARY]);
    // the OM -> CL hand-off is validated by the decision and by nothing else
    expect(users(/\bvalidateOMToCLHandoff\(/, [CONTRACT])).toEqual([DECISION]);
  });

  it('the boundary is not constructed anywhere in production and no sink is wired: learning is not activated', () => {
    expect(users(/new\s+LearningReleaseBoundary\s*\(/, [])).toEqual([]);
    expect(users(/\bLearningReleaseBoundary\b/, [BOUNDARY, 'packages/outcome-monitoring-runtime/src/index.ts'])).toEqual([]);
  });

  it('no production code outside the database package can reach a Continuous Learning or OM -> CL entry point', () => {
    const entryPoints = /\b(CLIntakeRepository|LearningFeedbackRepository|CLFeedbackPublicationRepository|LearningCaseRepository|LearnedLessonRepository|LearningPatternRepository|ImprovementProposalRepository|KnowledgeArtifactRepository|LearningChangeReviewRepository|PolicyEvaluationRepository|ModelEvaluationRepository|OMPublicationRepository|LearningFeedbackPackageRepository|OutcomeReviewRepository)\b/;
    expect(production.filter((f) => !f.rel.startsWith(DB_SRC) && entryPoints.test(f.code)).map((f) => f.rel)).toEqual([]);
    // nor the schemas by name
    expect(production.filter((f) => !f.rel.startsWith(DB_SRC) && !f.rel.startsWith('layers/continuous-learning/') && /continuous_learning\.|outcome_monitoring\.learning_feedback|outcome_monitoring\.om_publication/.test(f.code)).map((f) => f.rel)).toEqual([]);
  });

  it('there is no parallel gate: neither the decision nor the boundary restates the learning rule or names an outcome or execution state', () => {
    for (const rel of [DECISION, BOUNDARY]) {
      const code = read(rel);
      expect(code, rel).not.toMatch(/['"](OUTCOME_(PENDING|OBSERVED|VERIFIED|INCONCLUSIVE|FAILED)|EXECUTION_VERIFIED|SUCCEEDED|APPLIED|NO_CHANGE|REFUSED)['"]/);
    }
    expect(read(DECISION)).toMatch(/learningEligibility\(\{/);
  });

  it('the boundary and the decision are read-only: no SQL, no transaction, no event, no Business Operations, Approved Business Action or Continuous Learning import', () => {
    for (const rel of [DECISION, BOUNDARY]) {
      const code = read(rel);
      expect(code, rel).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP)\b\s+(INTO|FROM|TABLE|\w+\.\w+)/i);
      expect(code, rel).not.toMatch(/withTenantTransaction|withTransaction|\.query\(|publish\w*\(|buildActionExecutedEvent|OutboxRepository|from\s+'@infinicus\/(business-operations-runtime|workflow|event-worker)'/);
    }
    const imports = [...new Set([...read(BOUNDARY).matchAll(/from\s+'(@infinicus\/[a-z-]+)'/g)].map((m) => m[1]))].sort();
    expect(imports).toEqual(['@infinicus/database', '@infinicus/handoff-contracts']);
  });

  it('the source lookup is a single read-only method scoped by tenant context, and it judges nothing', () => {
    const code = read(READER);
    const start = code.indexOf('async learningSourcesForObservation');
    expect(start).toBeGreaterThan(0);
    const body = code.slice(start);
    expect(body).toMatch(/withTenantTransaction/);
    expect(body).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b\s+(INTO|FROM|\w+\.\w+)/i);
    expect(body).not.toMatch(/learningEligibility|eligible|released|OUTCOME_VERIFIED/);
  });

  it('no new outcome or execution state was introduced: the vocabulary and the database check are unchanged', () => {
    const states = read(GATE);
    expect(states).toMatch(/OUTCOME_STATES = \['OUTCOME_PENDING', 'OUTCOME_OBSERVED', 'OUTCOME_VERIFIED', 'OUTCOME_INCONCLUSIVE', 'OUTCOME_FAILED'\]/);
    expect(states).toMatch(/INITIAL_OUTCOME_STATES = \['OUTCOME_PENDING', 'OUTCOME_INCONCLUSIVE'\]/);
    expect(states).toMatch(/EXECUTION_STATES = \['EXECUTION_VERIFIED'\]/);
  });
});
