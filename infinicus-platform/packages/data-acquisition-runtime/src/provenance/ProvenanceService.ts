import { createHash } from 'crypto';
import {
  ProvenanceRepository,
  type TenantContext,
} from '@infinicus/database';
import type { PoolClient } from 'pg';
import type { ProvenanceInput } from '../types.js';
import { NORMALIZE_TRANSFORMATION_TYPE, OPERATIONAL_PROFILE_VERSION } from '../preparation/operationalRecordProfile.js';

/**
 * Canonicalizes a JSON-compatible value into a stable string: object keys
 * sorted lexicographically at every level, no incidental whitespace, arrays
 * kept in their original order (array order is semantically significant;
 * key order is not). Two records that are structurally identical but were
 * serialized with keys in a different order canonicalize to the same
 * string — required by BUILD-31 §4.9's "duplicate record detection must
 * use a deterministic canonical representation" and §4.11's "canonicalize
 * records before hashing."
 *
 * Only plain objects, arrays, strings, finite numbers, booleans, and null
 * survive this far — ManualRecordValidator rejects everything else
 * (undefined, functions, symbols, NaN/Infinity) before a record reaches
 * canonicalization, so this function does not re-validate; it assumes a
 * JSON-compatible value and would produce `undefined` in its own output
 * for anything else, same as JSON.stringify.
 */
export function canonicalizeRecord(value: unknown): string {
  return canonicalizeValue(value);
}

function canonicalizeValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalizeValue).join(',') + ']';
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const parts = keys.map(
      (k) => JSON.stringify(k) + ':' + canonicalizeValue((value as Record<string, unknown>)[k])
    );
    return '{' + parts.join(',') + '}';
  }
  // Unreachable once ManualRecordValidator has run, but a defined fallback
  // is safer than an exception deep inside a hashing routine.
  return 'null';
}

/** SHA-256 of the canonical JSON representation, as lowercase hex. */
export function hashRecord(value: unknown): string {
  return createHash('sha256').update(canonicalizeRecord(value), 'utf8').digest('hex');
}

const repo = new ProvenanceRepository();

export class ProvenanceService {
  /**
   * Creates one provenance record (plus a canonicalization transformation
   * record) for an accepted manual-intake record, on the caller's client so
   * it lands in the same transaction as the rest of the intake sequence
   * (BUILD-31 §6.5 groups validation and its provenance under one atomic
   * write, and provenance must never be recorded for a record that the
   * surrounding transaction ultimately rolls back).
   *
   * Missing-parent rejection and the maximum-lineage-depth guard live in
   * ProvenanceRepository.createOn — this service does not duplicate them.
   */
  async recordOn(
    client: PoolClient,
    ctx: TenantContext,
    input: ProvenanceInput
  ): Promise<string> {
    const canonical = canonicalizeRecord(input.record);
    const hash = hashRecord(input.record);

    const transformations = [
      {
        transformationType: 'canonicalize',
        transformationVersion: '1.0',
        inputHash: hash,
        outputHash: hash,
        parameters: { canonicalLength: canonical.length } as Record<string, unknown>,
        performedByType: 'system' as const,
      },
    ];
    if (input.preparedRecord !== undefined) {
      transformations.push({
        transformationType: NORMALIZE_TRANSFORMATION_TYPE,
        transformationVersion: OPERATIONAL_PROFILE_VERSION,
        inputHash: hash,
        outputHash: hashRecord(input.preparedRecord),
        parameters: { actions: (input.preparationActions ?? []).map((a) => ({ field: a.field, rule: a.rule })) },
        performedByType: 'system' as const,
      });
    }

    const { provenance } = await repo.createOn(
      client,
      ctx,
      {
        businessId: input.businessId,
        dataSourceId: input.dataSourceId,
        collectionRunId: input.collectionRunId,
        recordReference: input.recordReference,
        sourceReference: input.sourceReference,
        sourceHash: hash,
        parentProvenanceId: input.parentProvenanceId,
        correlationId: input.correlationId,
      },
      transformations
    );

    return provenance.id;
  }
}
