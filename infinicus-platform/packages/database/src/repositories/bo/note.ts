/**
 * Order note planning (POS-6c): turn what the cashier typed into the value to store. Pure.
 *
 * Rules: surrounding whitespace is trimmed; an empty note clears it (stored as NULL); at most NOTE_MAX characters; never a card number (13 or more digits in a
 * row, each pair optionally separated by one space or hyphen, the same rule the database enforces in migration 0207). A note is internal text, not a receipt line.
 */
import { looksLikeCardNumber } from './tender.js';

export const NOTE_MAX = 500;

/** A refused note. The API maps this name to 400. */
export class NoteError extends Error {
  constructor(reason: string) {
    super(`Note invalid: ${reason}`);
    this.name = 'ValidationError';
  }
}

export function planNote(input: string | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'string') throw new NoteError('the note must be text');
  const text = input.trim();
  if (text === '') return null;
  if (text.length > NOTE_MAX) throw new NoteError(`the note is too long (at most ${NOTE_MAX} characters)`);
  if (looksLikeCardNumber(text)) throw new NoteError('the note looks like it contains a card number; never write card numbers in a note');
  return text;
}
