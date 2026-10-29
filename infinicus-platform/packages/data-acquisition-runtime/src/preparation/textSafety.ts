/**
 * R-01A-R2 (F2): characters that cannot be stored in the PostgreSQL jsonb payload (NUL, lone surrogates) or that are non-text control codes.
 *
 * Deliberately narrow: legitimate international text is untouched. Tab, line feed and carriage return stay allowed (free-text notes). Zero-width
 * joiners/non-joiners are NOT restricted here - they are required by some scripts - and identifier fields are already limited to ASCII by their patterns.
 */

const MAX_SCAN_DEPTH = 64;

/** Returns a description of the first prohibited code unit in the string, or null. */
export function prohibitedCharacterIn(value: string): string | null {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c === 0) return 'NUL';
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || (c >= 0x7f && c <= 0x9f)) return 'control character';
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return 'unpaired surrogate';
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return 'unpaired surrogate';
    }
  }
  return null;
}

/**
 * Scans every string and every object key of a record (iteratively, so depth cannot overflow the stack). Returns the JSON-style path of the first
 * offender and what it was, or null. The offending text itself is never returned.
 */
export function findProhibitedCharacter(record: unknown): { path: string; kind: string } | null {
  const stack: Array<{ value: unknown; path: string; depth: number }> = [{ value: record, path: '$', depth: 0 }];
  while (stack.length > 0) {
    const { value, path, depth } = stack.pop()!;
    if (typeof value === 'string') {
      const kind = prohibitedCharacterIn(value);
      if (kind) return { path, kind };
    } else if (depth < MAX_SCAN_DEPTH && Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i--) stack.push({ value: value[i], path: `${path}[${i}]`, depth: depth + 1 });
    } else if (depth < MAX_SCAN_DEPTH && value !== null && typeof value === 'object') {
      const keys = Object.keys(value as Record<string, unknown>);
      for (let i = keys.length - 1; i >= 0; i--) {
        const key = keys[i];
        const kind = prohibitedCharacterIn(key);
        if (kind) return { path: `${path}.<key ${i}>`, kind };
        stack.push({ value: (value as Record<string, unknown>)[key], path: `${path}.${key}`, depth: depth + 1 });
      }
    }
  }
  return null;
}
