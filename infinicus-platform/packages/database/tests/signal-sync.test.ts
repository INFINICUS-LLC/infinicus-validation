/**
 * CI-STAB-06A: negative and positive controls for helpers/signalSync.ts, the readiness-then-signal synchronization behind the H-5 offsite-backup SIGTERM test.
 * Disposable fixtures only: tiny bash processes in a private temporary directory. No database, no production script, no network.
 *
 * A synchronization helper that can never fail proves nothing, so each way the H-5 test could go wrong must be seen to FAIL here, with a diagnostic and without
 * hanging: the marker is never produced, the process exits before it, the process exits before the signal, and the signal is not handled.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { awaitExit, processesMatching, sendSignal, waitForNoProcesses, waitForReadiness } from './helpers/signalSync.js';

describe('signalSync: the readiness-then-signal protocol of the H-5 test', () => {
  let dir: string;
  let marker: string;
  let token: string;
  const children: ChildProcess[] = [];

  /** Starts `bash -c <script>` with MARKER and TOKEN in its environment. The script is a fixture, never the production script. */
  const start = (script: string): ChildProcess => {
    const child = spawn('bash', ['-c', script], { env: { PATH: process.env.PATH as string, MARKER: marker, TOKEN: token }, stdio: 'ignore' });
    children.push(child);
    return child;
  };
  /** What a mocked fetch does: publish the token atomically, then block. */
  const publish = 'printf "%s" "$TOKEN" > "$MARKER.tmp" && mv "$MARKER.tmp" "$MARKER"';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'signal-sync-'));
    marker = join(dir, 'ready');
    token = `ready-${randomUUID()}`;
  });
  afterEach(() => {
    for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  });

  it('POSITIVE CONTROL: readiness, SIGTERM, exit 143 from the TERM trap, no leftover process', async () => {
    const needle = `needle-${randomUUID()}`;
    const child = start(`trap 'exit 143' TERM; ${publish}; while :; do sleep 0.05; done # ${needle}`);
    await waitForReadiness(child, marker, token, { timeoutMs: 5_000 });
    sendSignal(child, 'SIGTERM');
    expect(await awaitExit(child, { timeoutMs: 5_000 })).toEqual({ code: 143, signal: null });
    expect(await waitForNoProcesses(needle, 3_000)).toEqual([]);
  });

  it('NEGATIVE 1: a process that never produces the marker is reported after the bound, not waited on forever, and is killed', async () => {
    const child = start('sleep 30');
    const started = Date.now();
    await expect(waitForReadiness(child, marker, token, { timeoutMs: 300, context: () => 'fixture context' }))
      .rejects.toThrow(/readiness not reached: the marker did not appear within 300 ms \| fixture context/);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect((await awaitExit(child, { timeoutMs: 3_000 })).signal).toBe('SIGKILL');
  });

  it('NEGATIVE 2: a process that exits before reaching the marker is reported with its exit status', async () => {
    const child = start('exit 3');
    await expect(waitForReadiness(child, marker, token, { timeoutMs: 5_000 })).rejects.toThrow(/the process exited \(exit code 3 signal null\) before the marker appeared/);
  });

  it('NEGATIVE 3: a process that publishes the marker and then exits is detected when the signal would be sent, not silently signalled', async () => {
    const child = start(`${publish}; exit 0`);
    await waitForReadiness(child, marker, token, { timeoutMs: 5_000 });
    await awaitExit(child, { timeoutMs: 5_000 });
    expect(() => sendSignal(child, 'SIGTERM')).toThrow(/cannot deliver SIGTERM: the process had already exited \(exit code 0 signal null\)/);
  });

  it('NEGATIVE 4: SIGTERM that is not handled (ignored) is reported after the bound and the process is killed', async () => {
    const child = start(`trap '' TERM; ${publish}; while :; do sleep 0.05; done`);
    await waitForReadiness(child, marker, token, { timeoutMs: 5_000 });
    sendSignal(child, 'SIGTERM');
    await expect(awaitExit(child, { timeoutMs: 300, context: () => 'fixture context' })).rejects.toThrow(/did not terminate within 300 ms of the signal \| fixture context/);
    expect((await awaitExit(child, { timeoutMs: 3_000 })).signal).toBe('SIGKILL');
  });

  it('NEGATIVE 5: a stale or foreign marker (different token) does not satisfy readiness', async () => {
    writeFileSync(marker, 'ready-someone-else');
    const child = start('sleep 30');
    await expect(waitForReadiness(child, marker, token, { timeoutMs: 300 })).rejects.toThrow(/the marker did not appear within 300 ms/);
    expect(existsSync(marker)).toBe(true); // the helper never deletes what it did not create; the caller cleans up
  });

  it('NEGATIVE 6: a surviving helper process is reported (so an orphaned fetch fails the H-5 test)', async () => {
    const needle = `needle-${randomUUID()}`;
    // two commands, so bash stays the process (a lone `sleep` would be exec'd and its command line would no longer hold the needle)
    const survivor = start(`sleep 30; : # ${needle}`);
    expect(await waitForNoProcesses(needle, 300)).toContain(survivor.pid);
    survivor.kill('SIGKILL');
    await awaitExit(survivor, { timeoutMs: 3_000 });
    expect(processesMatching(needle)).toEqual([]);
  });
});
