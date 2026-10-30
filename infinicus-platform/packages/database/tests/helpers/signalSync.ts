/**
 * Test helper: deliver a signal to a child process only AFTER it has provably reached a known point, and wait for its exit with a bound.
 *
 * Why it exists (CI-STAB-05 / CI-STAB-06A): the H-5 offsite-backup SIGTERM test used to send SIGTERM as soon as restore-proof.sh's temporary directory
 * appeared. At that instant the script is still running its start-up lines, which are full of command substitutions (`[[ "$(stat ...)" == "700 $(id -u)" ]]`).
 * Bash 5.2.21 can run a trap handler while it is inside such a substitution and then reports `trap: line 2: unexpected EOF while looking for matching ')'`:
 * the signal is swallowed and the script exits 2 instead of 143 (a faithful micro-script reproduced it in 121 of 1500 runs; 0 of 1500 without that line).
 * The fix is to make the test wait until the script is parked in its blocking fetch, which is long after every start-up substitution has finished.
 *
 * How: the mocked fetch writes a unique token to a marker file (atomically, via rename) immediately before it blocks. `waitForReadiness` returns only when the
 * file holds exactly that token, so a stale or foreign file cannot satisfy it. No sleep stands in for readiness. Every wait is bounded and fails with the
 * caller's diagnostic instead of hanging, and a process that was left running is killed so nothing is orphaned.
 */
import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const hasExited = (child: ChildProcess): boolean => child.exitCode !== null || child.signalCode !== null;
const describeExit = (child: ChildProcess): string => `exit code ${child.exitCode} signal ${child.signalCode}`;

export interface SyncOptions {
  /** Upper bound for the wait, in milliseconds. */
  timeoutMs?: number;
  /** Poll interval, in milliseconds. */
  pollMs?: number;
  /** Extra context appended to every failure (the script's own output, for example). It must never contain secrets. */
  context?: () => string;
}

const contextOf = (o: SyncOptions): string => { try { return o.context ? ` | ${o.context()}` : ''; } catch { return ''; } };

/** Resolves once `marker` holds exactly `token`. Rejects if the process exits first or the bound is reached (and then kills the process). */
export async function waitForReadiness(child: ChildProcess, marker: string, token: string, o: SyncOptions = {}): Promise<void> {
  const timeoutMs = o.timeoutMs ?? 30_000;
  const pollMs = o.pollMs ?? 10;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(marker)) {
      let content = '';
      try { content = readFileSync(marker, 'utf8'); } catch { /* removed or replaced between the two calls: look again */ }
      if (content === token) return;
    }
    if (hasExited(child)) throw new Error(`readiness not reached: the process exited (${describeExit(child)}) before the marker appeared${contextOf(o)}`);
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`readiness not reached: the marker did not appear within ${timeoutMs} ms${contextOf(o)}`);
    }
    await sleep(pollMs);
  }
}

/** Sends `signal`. Rejects when the process is already gone: a signal sent to an exited process proves nothing about its handler. */
export function sendSignal(child: ChildProcess, signal: NodeJS.Signals, o: SyncOptions = {}): void {
  if (hasExited(child)) throw new Error(`cannot deliver ${signal}: the process had already exited (${describeExit(child)}) before the signal was sent${contextOf(o)}`);
  if (!child.kill(signal)) throw new Error(`cannot deliver ${signal}: the operating system refused the signal${contextOf(o)}`);
}

/** Resolves with the exit status. Rejects, after killing the process, when it is still running after the bound (the signal was not handled). */
export async function awaitExit(child: ChildProcess, o: SyncOptions = {}): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const timeoutMs = o.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  while (!hasExited(child)) {
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`the process did not terminate within ${timeoutMs} ms of the signal${contextOf(o)}`);
    }
    await sleep(10);
  }
  return { code: child.exitCode, signal: child.signalCode };
}

/** Process ids whose command line contains `needle` (Linux /proc). Used to prove that no helper process outlived the test. */
export function processesMatching(needle: string): number[] {
  const found: number[] = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    try { if (readFileSync(`/proc/${entry}/cmdline`, 'utf8').includes(needle)) found.push(Number(entry)); } catch { /* the process ended while it was being read */ }
  }
  return found;
}

/** Resolves with [] as soon as no process matches, or with the survivors once the bound is reached. */
export async function waitForNoProcesses(needle: string, timeoutMs = 5_000): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const left = processesMatching(needle);
    if (left.length === 0 || Date.now() > deadline) return left;
    await sleep(25);
  }
}
