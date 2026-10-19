/**
 * restore-proof.sh must install its signal traps BEFORE it creates its temporary directory (pure; no database).
 *
 * The CI failure of 18-19 Oct 2026 ("wipes the temporary directory when interrupted (SIGTERM)": expected exit 143, received null) was a race: the
 * directory was created first and the traps afterwards, so a SIGTERM arriving in between hit bash's default action. The script died at once (killed
 * by the signal, exit status null for the caller) and left the directory behind. The race window is tiny on an idle machine and large on a loaded CI
 * runner. This guard checks the order in the source, so it cannot come back, and it does not depend on timing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SCRIPT = readFileSync(resolve(__dirname, '../../../infrastructure/backups/restore-proof.sh'), 'utf8');
const at = (needle: string): number => {
  const i = SCRIPT.indexOf(needle);
  expect(i, `missing in restore-proof.sh: ${needle}`).toBeGreaterThan(-1);
  return i;
};

describe('restore-proof.sh signal handling order', () => {
  it('installs the EXIT, HUP, INT and TERM traps before the temporary directory is created', () => {
    const created = at('WORK="$(mktemp -d');
    for (const trap of ["trap cleanup EXIT", "trap 'exit 129' HUP", "trap 'exit 130' INT", "trap 'exit 143' TERM"]) {
      expect(at(trap), trap).toBeLessThan(created);
    }
  });

  it('declares WORK and SCRATCH_CREATED before the traps can fire, and the wipe tolerates an empty WORK (never rm -rf of an empty path)', () => {
    const firstTrap = at('trap cleanup EXIT');
    expect(at('WORK=""')).toBeLessThan(firstTrap);
    expect(at('SCRATCH_CREATED=0')).toBeLessThan(firstTrap);
    expect(SCRATCH_GUARD.test(SCRIPT)).toBe(true);
  });

  it('creates the directory exactly once', () => {
    expect(SCRIPT.match(/mktemp -d/g)).toHaveLength(1);
  });
});

const SCRATCH_GUARD = /wipe_work\(\) \{\n\s*\[\[ -n "\$WORK" && -d "\$WORK" \]\] \|\| return 0/;
