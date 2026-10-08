import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { sha256Hex, utf8Bytes } from '../src';

const hex = (s: string): string => sha256Hex(utf8Bytes(s));

describe('pure SHA-256', () => {
  it('matches the NIST vectors', () => {
    expect(hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });

  it('matches the one-million-"a" vector', () => {
    expect(sha256Hex(new Uint8Array(1_000_000).fill(0x61))).toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
  });

  it('agrees with node:crypto on every length around the block boundaries', () => {
    for (let n = 0; n <= 200; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 31 + n) & 0xff);
      expect(sha256Hex(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'));
    }
  });

  it('agrees with node:crypto on unicode text, including astral characters', () => {
    for (const s of ['plain', 'café', '日本語', '🚀 rocket', 'mixed é中🚀 text', '\u0000\u0001\u007f']) {
      expect(hex(s)).toBe(createHash('sha256').update(s, 'utf8').digest('hex'));
    }
  });

  it('encodes UTF-8 exactly like Node and replaces a lone surrogate with U+FFFD', () => {
    expect(Buffer.from(utf8Bytes('aé中🚀')).equals(Buffer.from('aé中🚀', 'utf8'))).toBe(true);
    expect(Buffer.from(utf8Bytes('\ud800')).equals(Buffer.from('�', 'utf8'))).toBe(true);
  });
});
