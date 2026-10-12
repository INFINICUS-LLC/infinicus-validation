import { describe, expect, it } from 'vitest';
import { resolveBuildVersion } from '../src/buildVersion.js';

describe('resolveBuildVersion', () => {
  it('returns a valid commit id (lower-cased, trimmed) and nothing else', () => {
    expect(resolveBuildVersion({ INFINICUS_BUILD_SHA: '842F2BB80347D90E77184A5F2394A31C92DF7161' })).toBe('842f2bb80347d90e77184a5f2394a31c92df7161');
    expect(resolveBuildVersion({ INFINICUS_BUILD_SHA: ' abc1234 \n' })).toBe('abc1234');
  });

  it('reports "unknown" when unset, empty, too short, too long, or not a hex commit id (never echoes the value)', () => {
    for (const v of [undefined, '', '  ', 'abc123', 'g'.repeat(40), 'a'.repeat(41), 'unknown', 'postgresql://app_role:secret@host/db', 'abc1234; rm -rf /']) {
      expect(resolveBuildVersion({ INFINICUS_BUILD_SHA: v })).toBe('unknown');
    }
    expect(resolveBuildVersion({})).toBe('unknown');
  });
});
