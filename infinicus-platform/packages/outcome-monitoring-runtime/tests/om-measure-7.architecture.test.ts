import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('OM-MEASURE-7 remains preparatory', () => {
  it('has no verdict writer or learning release dependency', () => {
    const preflight = read('packages/outcome-monitoring-runtime/src/VerificationRefusalAssessment.ts');
    expect(preflight).toContain('verdictAllowed: false');
    expect(preflight).not.toMatch(/GovernedMeasurementVerdictRepository|LearningReleaseBoundary|INSERT INTO|UPDATE\s+outcome_monitoring/i);
  });

  it('preserves the database and single learning gate restrictions', () => {
    const verdictMigration = read('infrastructure/database/migrations/0215_record_governed_measurement_assessments.sql');
    const gate = read('packages/handoff-contracts/src/execution-evidence/states.ts');
    expect(verdictMigration).toContain("outcome_state IN ('OUTCOME_PENDING','OUTCOME_INCONCLUSIVE')");
    expect(gate).toContain("i.outcomeState !== 'OUTCOME_VERIFIED'");
  });
});
