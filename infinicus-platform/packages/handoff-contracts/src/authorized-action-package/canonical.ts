// Canonical form 'aap-canonical/1' and the package integrity digest (P0-5 Block 2; owner integrity ruling).
//
// The digest is TAMPER EVIDENCE ONLY. It does not establish authorization and does not replace RBAC, approval
// provenance or Business Operations validation.
//
// aap-canonical/1 (modelled on RFC 8785 JSON Canonicalization, restricted value domain):
//  - input is a JSON value: null, boolean, finite number, string, array, plain object. `undefined`, functions, symbols,
//    bigint, NaN, +/-Infinity, non-plain objects (Date, Map, class instances), cyclic structures and sparse arrays are
//    REJECTED, never silently dropped, so equal-looking inputs cannot hash differently or tamper silently.
//  - objects: keys sorted by UTF-16 code unit order, no insignificant whitespace, `{"k":v,...}`; array order is preserved.
//  - numbers: the ECMAScript shortest round-trip form (as JSON.stringify), -0 serialized as 0; integers beyond the safe
//    integer range are rejected (money and large quantities are carried as decimal strings).
//  - strings: JSON string escaping (as JSON.stringify), UTF-8 on the wire; strings with lone surrogates are rejected.
//  - governed applicability is encoded structurally ({"state":"VALUE",...} / {"state":"NOT_APPLICABLE",...}), so a change of
//    applicability state changes the digest.
//  - SHA-256 comes from the platform's trusted crypto implementation (node:crypto); nothing bespoke is maintained.
//  - the digest input is UTF-8 of `aap-canonical/1` + "\n" + the canonical form of the package WITHOUT its `integrity`
//    block (the version prefix is domain separation: a different canonical version can never produce the same digest). The
//    canonical form itself carries `contractVersion`. Digest string: `sha256:<64 lowercase hex>`.
//  - covered: every field capable of changing what is executed, for whom, under which authorization and within which
//    validity/constraints (that is: everything except `integrity` itself).

import { createHash } from 'node:crypto';
import { AAP_CANONICAL_VERSION, AAP_DIGEST_ALGORITHM } from './types';
import type { AuthorizedActionPackageBody, AuthorizedActionPackageV1, PackageIntegrity } from './types';

/**
 * SHA-256 of a string (UTF-8) as 64 lowercase hex characters, computed by the platform's trusted cryptographic
 * implementation (Node.js `crypto`, OpenSSL-backed). No bespoke implementation is maintained. Callers must have
 * rejected lone surrogates first (canonicalize does), so UTF-8 encoding is exact.
 */
export function sha256HexOfText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export class CanonicalizationError extends Error {
  constructor(public readonly path: string, public readonly reason: string) {
    super(`not canonicalizable at ${path}: ${reason}`);
    this.name = 'CanonicalizationError';
  }
}

const MAX_DEPTH = 32;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) { i++; continue; }
      return true;
    }
    if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

function serialize(value: unknown, path: string, depth: number, seen: Set<object>): string {
  if (depth > MAX_DEPTH) throw new CanonicalizationError(path, `nesting deeper than ${MAX_DEPTH}`);
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number': {
      if (!Number.isFinite(value)) throw new CanonicalizationError(path, 'non-finite number');
      if (Number.isInteger(value) && !Number.isSafeInteger(value)) throw new CanonicalizationError(path, 'integer outside the safe range (use a decimal string)');
      return Object.is(value, -0) ? '0' : JSON.stringify(value);
    }
    case 'string':
      if (hasLoneSurrogate(value)) throw new CanonicalizationError(path, 'string contains a lone surrogate');
      return JSON.stringify(value);
    case 'object': {
      const obj = value as object;
      if (seen.has(obj)) throw new CanonicalizationError(path, 'cyclic structure');
      seen.add(obj);
      try {
        if (Array.isArray(obj)) {
          const parts: string[] = [];
          for (let i = 0; i < obj.length; i++) {
            if (!(i in obj)) throw new CanonicalizationError(`${path}[${i}]`, 'sparse array');
            parts.push(serialize(obj[i], `${path}[${i}]`, depth + 1, seen));
          }
          return `[${parts.join(',')}]`;
        }
        const proto = Object.getPrototypeOf(obj);
        if (proto !== Object.prototype && proto !== null) throw new CanonicalizationError(path, 'non-plain object');
        const keys = Object.keys(obj).sort();
        const parts: string[] = [];
        for (const key of keys) {
          if (hasLoneSurrogate(key)) throw new CanonicalizationError(`${path}.${key}`, 'key contains a lone surrogate');
          const child = (obj as Record<string, unknown>)[key];
          if (child === undefined) throw new CanonicalizationError(`${path}.${key}`, 'undefined value');
          parts.push(`${JSON.stringify(key)}:${serialize(child, `${path}.${key}`, depth + 1, seen)}`);
        }
        return `{${parts.join(',')}}`;
      } finally {
        seen.delete(obj);
      }
    }
    default:
      throw new CanonicalizationError(path, `unsupported type ${typeof value}`);
  }
}

/** The canonical string of a JSON value under aap-canonical/1. Throws CanonicalizationError when the value is outside the domain. */
export function canonicalize(value: unknown): string {
  return serialize(value, '$', 0, new Set());
}

/** The package content the digest covers: everything except the `integrity` block. */
export function digestCoveredContent(pkg: AuthorizedActionPackageBody | AuthorizedActionPackageV1): AuthorizedActionPackageBody {
  const { integrity: _integrity, ...body } = pkg as AuthorizedActionPackageV1;
  return body;
}

/** `sha256:<hex>` over the canonical form of the package body (integrity excluded). Tamper evidence only. */
export function computePackageDigest(pkg: AuthorizedActionPackageBody | AuthorizedActionPackageV1): string {
  return `sha256:${sha256HexOfText(`${AAP_CANONICAL_VERSION}\n${canonicalize(digestCoveredContent(pkg))}`)}`;
}

export function isWellFormedDigest(digest: unknown): digest is string {
  return typeof digest === 'string' && DIGEST_PATTERN.test(digest);
}

/** The integrity block for a body. Sealing a package for issuance is done by sealAuthorizedActionPackage (validator.ts). */
export function buildIntegrity(body: AuthorizedActionPackageBody): PackageIntegrity {
  return { canonicalVersion: AAP_CANONICAL_VERSION, algorithm: AAP_DIGEST_ALGORITHM, digest: computePackageDigest(body) };
}
