import { describe, it, expect } from 'vitest';
import { planNote, NoteError, NOTE_MAX } from '../src/repositories/bo/note.js';

describe('planNote (pure)', () => {
  it('trims the text; an empty, blank, null or missing note clears it (null)', () => {
    expect(planNote('  table 4, no sugar  ')).toBe('table 4, no sugar');
    for (const empty of ['', '   ', '\n\t', null, undefined]) expect(planNote(empty), JSON.stringify(empty)).toBeNull();
  });

  it('keeps ordinary text, digits and punctuation, including short numbers and phone-like groups', () => {
    expect(planNote('Pick up at 18:30, order for Ali (055 123)')).toBe('Pick up at 18:30, order for Ali (055 123)');
    expect(planNote('Table 12')).toBe('Table 12');
    expect(planNote('12 345 678')).toBe('12 345 678');
  });

  it('allows exactly the maximum length and refuses one more', () => {
    expect(planNote('x'.repeat(NOTE_MAX))).toHaveLength(NOTE_MAX);
    expect(() => planNote('x'.repeat(NOTE_MAX + 1))).toThrow(/too long/);
    expect(planNote(` ${'x'.repeat(NOTE_MAX)} `)).toHaveLength(NOTE_MAX);   // the limit applies after trimming
  });

  it('refuses anything that looks like a card number, however it is separated', () => {
    for (const bad of ['4111111111111111', '4111 1111 1111 1111', '4111-1111-1111-1111', 'card is 4111 1111 1111 1111 ok', '1234567890123']) {
      expect(() => planNote(bad), bad).toThrow(/card number/);
    }
  });

  it('a refused note carries the name the API maps to 400; a non-text value is refused', () => {
    try { planNote('x'.repeat(NOTE_MAX + 1)); } catch (e) { expect((e as Error).name).toBe('ValidationError'); expect(e).toBeInstanceOf(NoteError); return; }
    throw new Error('expected a refusal');
  });
  it('rejects a non-string input', () => {
    expect(() => planNote(42 as unknown as string)).toThrow(NoteError);
  });
});
