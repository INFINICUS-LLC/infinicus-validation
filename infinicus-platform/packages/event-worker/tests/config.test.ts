import { describe, expect, it } from 'vitest';
import { WORKER_ENV, WorkerConfigError, loadWorkerConfig } from '../src/index.js';

const good = {
  [WORKER_ENV.workerId]: 'worker-1',
  [WORKER_ENV.actorUserId]: '00000000-0000-4000-8000-000000000001',
  [WORKER_ENV.discoveryDatabaseUrl]: 'postgresql://discovery',
  [WORKER_ENV.intakeStatusMaxAgeMs]: '5000',
  [WORKER_ENV.executionStatusMaxAgeMs]: '5000',
  [WORKER_ENV.claimTimeoutMs]: '60000',
  [WORKER_ENV.batchSize]: '20',
  [WORKER_ENV.maxScopesPerCycle]: '50',
  [WORKER_ENV.pollIntervalMs]: '2000',
};

describe('loadWorkerConfig', () => {
  it('reads a complete environment', () => {
    expect(loadWorkerConfig(good)).toEqual({
      workerId: 'worker-1', actorUserId: '00000000-0000-4000-8000-000000000001', discoveryDatabaseUrl: 'postgresql://discovery',
      intakeStatusMaxAgeMs: 5000, executionStatusMaxAgeMs: 5000, claimTimeoutMs: 60000, batchSize: 20, maxScopesPerCycle: 50, pollIntervalMs: 2000,
    });
  });

  it('has no defaults: every missing variable is reported and the worker does not start', () => {
    let error: unknown;
    try { loadWorkerConfig({}); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(WorkerConfigError);
    const problems = (error as WorkerConfigError).problems.join('|');
    for (const name of Object.values(WORKER_ENV)) expect(problems).toContain(name);
  });

  it('rejects malformed numbers, a non-UUID actor and out-of-range batch sizes', () => {
    for (const [name, value] of [
      [WORKER_ENV.intakeStatusMaxAgeMs, '0'], [WORKER_ENV.executionStatusMaxAgeMs, '0'], [WORKER_ENV.intakeStatusMaxAgeMs, '-5'], [WORKER_ENV.claimTimeoutMs, '1.5'], [WORKER_ENV.pollIntervalMs, 'soon'],
      [WORKER_ENV.actorUserId, 'not-a-uuid'], [WORKER_ENV.batchSize, '101'], [WORKER_ENV.maxScopesPerCycle, '501'], [WORKER_ENV.workerId, '  '],
    ] as const) {
      expect(() => loadWorkerConfig({ ...good, [name]: value }), `${name}=${value}`).toThrow(WorkerConfigError);
    }
  });
});
