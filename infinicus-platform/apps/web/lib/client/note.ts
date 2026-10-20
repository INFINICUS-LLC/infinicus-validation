/**
 * Order note entry for the counter (POS-6c): what the cashier typed, checked locally before anything is sent. The server and the database check everything
 * again. A note is internal text on an OPEN order: at most NOTE_MAX characters after trimming, an empty note clears it, and it never holds a card number.
 */
import { looksLikeCardNumber } from './tender';

export const NOTE_MAX = 500;
export type NoteResult = { ok: true; note: string | null } | { ok: false; reason: string };

export function buildNote(text: string): NoteResult {
  const note = text.trim();
  if (note.length > NOTE_MAX) return { ok: false, reason: `The note is too long (at most ${NOTE_MAX} characters).` };
  if (looksLikeCardNumber(note)) return { ok: false, reason: 'The note looks like it contains a card number. Never write card numbers in a note.' };
  return { ok: true, note: note === '' ? null : note };
}

/** A short one-line preview of a note for lists. */
export function notePreview(note: string | null | undefined, max = 40): string {
  const text = (note ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
