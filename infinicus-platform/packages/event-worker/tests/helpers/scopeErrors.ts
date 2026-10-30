/**
 * CI-STAB-02 R2: make the worker's swallowed scope errors visible to a test.
 *
 * EventWorker.runOnce() deliberately survives a scope that throws (one scope's failure must not stop the others): it counts the failure in
 * `scopeErrors` and calls the optional `onScopeError`. A test that supplies no callback and never reads the summary therefore sees only a
 * downstream symptom ("expected [] to have a length of 1") with no cause. These helpers record each swallowed error as a short, redacted
 * description and fail the test AT the cycle that swallowed it, naming the cause. Production behavior is not touched.
 */
import type { WorkerCycleSummary } from '../../src/EventWorker.js';

export interface ScopeErrorLog {
  readonly entries: string[];
  /** How many entries earlier checks have already accounted for. */
  checked: number;
}

export const newScopeErrorLog = (): ScopeErrorLog => ({ entries: [], checked: 0 });

const UUID_GLOBAL = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Error name, driver code and constraint when present, and the message with identifiers redacted and length bounded. Never the stack or any row data. */
export function describeScopeError(error: unknown): string {
  const e = (error ?? {}) as { name?: unknown; code?: unknown; constraint?: unknown; message?: unknown };
  const message = String(e.message ?? error).replace(UUID_GLOBAL, '<uuid>').replace(/\s+/g, ' ').slice(0, 300);
  return [
    typeof e.name === 'string' ? e.name : 'Error',
    typeof e.code === 'string' ? `code=${e.code}` : '',
    typeof e.constraint === 'string' ? `constraint=${e.constraint}` : '',
    message,
  ].filter(Boolean).join(' ');
}

/** The `onScopeError` callback to give `buildEventWorker`. */
export const recordScopeErrors = (log: ScopeErrorLog) => (_scope: { tenantId: string; workspaceId: string }, error: unknown): void => {
  log.entries.push(describeScopeError(error));
};

/**
 * Fails when the cycle that just ran swallowed a scope error. Use it after every `runOnce()` of a scenario that expects normal processing; a test that
 * expects a scope error must say so explicitly and read `log.entries` itself.
 */
export function assertNoScopeErrors(log: ScopeErrorLog, summary: Pick<WorkerCycleSummary, 'scopeErrors'>, label = 'worker cycle'): void {
  const fresh = log.entries.slice(log.checked);
  log.checked = log.entries.length;
  if (summary.scopeErrors === 0 && fresh.length === 0) return;
  throw new Error(`${label} swallowed ${Math.max(summary.scopeErrors, fresh.length)} scope error(s): ${fresh.length > 0 ? fresh.join(' || ') : '(counted but no callback entry)'}`);
}
