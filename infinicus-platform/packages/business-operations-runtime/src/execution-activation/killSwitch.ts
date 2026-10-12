/**
 * Key 3 of the execution gate: the process-level global kill switch (P0-6e; ruling O-11 - controlled by platform administration).
 *
 * It can only REMOVE capability. Absent means "not engaged" (the other two keys already default CLOSED, so absence opens nothing); any
 * recognised engaged value engages it; any UNRECOGNISED value also engages it, so a typo can never leave execution running.
 */
export const KILL_SWITCH_ENV = 'INFINICUS_EXECUTION_KILL_SWITCH';

const NOT_ENGAGED = new Set(['', '0', 'false', 'off', 'no']);

export function killSwitchEngagedFrom(env: Readonly<Record<string, string | undefined>>): boolean {
  const raw = env[KILL_SWITCH_ENV];
  if (raw === undefined) return false;
  return !NOT_ENGAGED.has(raw.trim().toLowerCase());
}
