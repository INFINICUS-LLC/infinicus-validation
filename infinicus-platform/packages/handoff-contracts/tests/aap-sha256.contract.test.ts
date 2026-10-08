import { describe, expect, it } from 'vitest';
import { createHash, webcrypto } from 'node:crypto';
import { sha256HexOfText, computePackageDigest, canonicalize, digestCoveredContent, AAP_CANONICAL_VERSION } from '../src';
import { approvedBody } from './aap-fixtures';

/**
 * SHA-256 comes from the trusted platform crypto (node:crypto); the contract keeps no bespoke implementation.
 * These tests pin the published vectors and prove the digest is the standard SHA-256 of the canonical text.
 */
describe('standard-crypto SHA-256', () => {
  it('matches the NIST vectors', () => {
    expect(sha256HexOfText('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256HexOfText('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256HexOfText('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });

  it('matches the one-million-"a" vector', () => {
    expect(sha256HexOfText('a'.repeat(1_000_000))).toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
  });

  it('agrees with Web Crypto on unicode text, including astral characters', async () => {
    for (const s of ['plain', 'café', '日本語', '🚀 rocket', 'mixed é中🚀 text', '\u0000\u0001\u007f']) {
      const web = Buffer.from(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(s))).toString('hex');
      expect(sha256HexOfText(s)).toBe(web);
    }
  });

  it('computePackageDigest is sha256: + SHA-256 of "aap-canonical/1\\n" + the canonical covered content', async () => {
    const pkg = { ...approvedBody(), integrity: { digest: 'sha256:' + '0'.repeat(64), canonicalization: AAP_CANONICAL_VERSION, algorithm: 'sha256' } } as never;
    const text = `${AAP_CANONICAL_VERSION}\n${canonicalize(digestCoveredContent(pkg))}`;
    const web = Buffer.from(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(text))).toString('hex');
    expect(computePackageDigest(pkg)).toBe(`sha256:${web}`);
    expect(computePackageDigest(pkg)).toBe(`sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`);
  });
});
