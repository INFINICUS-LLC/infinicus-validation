import type { BatchValidationOutcome, RecordValidationIssue } from '../types.js';
import { INVENTORY_ITEM_DEFAULT_UNIT_OF_MEASURE, PREPARED_KEY_RULE_CODES } from './operationalRecordProfile.js';
import type { PreparedRecord } from './OperationalRecordPreparer.js';

/**
 * R-01B-2: deterministic duplicate and conflict detection on PREPARED keys, within one submission.
 *
 * Reporting only. Nothing is dropped, merged or modified; Business Operations remains the final validator and the only writer. Findings carry field
 * NAMES and record positions, never field values. Pure: no clock, randomness, I/O or database access.
 *
 * Identity (mirrors the BO unique indexes, which are case-sensitive and exact):
 *   inventory_item -> sku            warehouse -> warehouseCode
 * Comparison against the FIRST occurrence (the anchor), mirroring BO's sequential create semantics:
 *   inventory_item: conflict if name differs, or if the later record states a unitOfMeasure that differs from what BO stored for the anchor
 *                   (the anchor's unitOfMeasure, or 'unit' when it stated none); a later record that states none never conflicts.
 *   warehouse:      conflict if name differs.
 * inventory_movement has no approved identity contract in BO and is intentionally never classified.
 */

export type PreparedKeyFindingKind = 'EXACT_DUPLICATE' | 'CONFLICT';

export interface PreparedKeyCandidate {
  recordIndex: number;
  prepared: PreparedRecord;
  /** SHA-256 of the raw record (the provenance source hash). */
  rawHash: string;
  /** SHA-256 of the prepared record (the provenance normalize output hash). */
  preparedHash: string;
  /** The key field exactly as supplied (before trim/NFC), used only to detect normalization collisions; never reported. */
  rawKeyText: string | null;
}

export interface PreparedKeyGroup {
  /** Stable id: record type plus the anchor's record index. */
  groupId: string;
  kind: PreparedKeyFindingKind;
  recordType: 'inventory_item' | 'warehouse';
  keyField: 'sku' | 'warehouseCode';
  /** Record indexes ascending; the first is the anchor. */
  members: Array<{ recordIndex: number; rawHash: string; preparedHash: string }>;
  /** Field names (never values) in which a later member differs from the anchor, sorted. */
  differingFields: string[];
  /** True when normalization erased a difference between members: their raw key text differs, or two members have identical prepared form but different raw form. */
  normalizationCollision: boolean;
}

export interface PreparedKeyFindings {
  groups: PreparedKeyGroup[];
  /** Issues per record index, ready to merge into the validation outcome. */
  issuesByRecord: Map<number, RecordValidationIssue[]>;
  /** Finding kinds per record index, for the persisted preparation outcome. */
  kindsByRecord: Map<number, string[]>;
}

const KEY_FIELD = { inventory_item: 'sku', warehouse: 'warehouseCode' } as const;

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

function conflictingFields(type: 'inventory_item' | 'warehouse', anchor: Record<string, unknown>, later: Record<string, unknown>): string[] {
  const fields: string[] = [];
  if (str(anchor.name) !== str(later.name)) fields.push('name');
  if (type === 'inventory_item' && later.unitOfMeasure !== undefined) {
    const stored = str(anchor.unitOfMeasure) ?? INVENTORY_ITEM_DEFAULT_UNIT_OF_MEASURE;
    if (str(later.unitOfMeasure) !== stored) fields.push('unitOfMeasure');
  }
  return fields;
}

export function detectPreparedKeyFindings(candidates: readonly PreparedKeyCandidate[]): PreparedKeyFindings {
  const ordered = [...candidates].sort((a, b) => a.recordIndex - b.recordIndex);
  const buckets = new Map<string, PreparedKeyCandidate[]>();
  for (const candidate of ordered) {
    const type = candidate.prepared.recordType;
    if (type !== 'inventory_item' && type !== 'warehouse') continue; // movements (and anything else) are never classified
    const key = candidate.prepared.data[KEY_FIELD[type]];
    if (typeof key !== 'string') continue;
    const bucketKey = `${type}\u0000${key}`; // exact, case-sensitive, like the BO unique indexes
    const bucket = buckets.get(bucketKey);
    if (bucket) bucket.push(candidate); else buckets.set(bucketKey, [candidate]);
  }

  const groups: PreparedKeyGroup[] = [];
  const issuesByRecord = new Map<number, RecordValidationIssue[]>();
  const kindsByRecord = new Map<number, string[]>();
  const addIssue = (recordIndex: number, issue: RecordValidationIssue, kind: string): void => {
    const list = issuesByRecord.get(recordIndex) ?? [];
    list.push(issue);
    issuesByRecord.set(recordIndex, list);
    const kinds = kindsByRecord.get(recordIndex) ?? [];
    if (!kinds.includes(kind)) kinds.push(kind);
    kindsByRecord.set(recordIndex, kinds);
  };

  for (const members of buckets.values()) {
    if (members.length < 2) continue;
    const anchor = members[0];
    const type = anchor.prepared.recordType as 'inventory_item' | 'warehouse';
    const keyField = KEY_FIELD[type];
    const differing = new Set<string>();
    for (const later of members.slice(1)) {
      for (const field of conflictingFields(type, anchor.prepared.data, later.prepared.data)) differing.add(field);
    }
    const kind: PreparedKeyFindingKind = differing.size > 0 ? 'CONFLICT' : 'EXACT_DUPLICATE';
    const rawsByPrepared = new Map<string, Set<string>>();
    for (const m of members) rawsByPrepared.set(m.preparedHash, (rawsByPrepared.get(m.preparedHash) ?? new Set<string>()).add(m.rawHash));
    const collision =
      members.some((m) => m.rawKeyText !== anchor.rawKeyText) || [...rawsByPrepared.values()].some((raws) => raws.size > 1);
    const differingFields = [...differing].sort();
    groups.push({
      groupId: `${type}#${anchor.recordIndex}`,
      kind,
      recordType: type,
      keyField,
      members: members.map((m) => ({ recordIndex: m.recordIndex, rawHash: m.rawHash, preparedHash: m.preparedHash })),
      differingFields,
      normalizationCollision: collision,
    });

    const peers = members.map((m) => m.recordIndex).join(', ');
    for (const member of members) {
      if (kind === 'CONFLICT') {
        addIssue(member.recordIndex, {
          ruleCode: PREPARED_KEY_RULE_CODES.conflict, fieldPath: `data.${keyField}`, severity: 'error', issueType: 'preparation',
          message: `${type} key is shared with records [${peers}] and they disagree on: ${differingFields.join(', ')}. Business Operations would refuse this; resolve before resubmitting.`,
        }, 'CONFLICT');
      } else {
        addIssue(member.recordIndex, {
          ruleCode: PREPARED_KEY_RULE_CODES.exactDuplicate, fieldPath: `data.${keyField}`, severity: 'warning', issueType: 'preparation',
          message: `${type} key is shared with records [${peers}] and the prepared records agree; all are kept.`,
        }, 'EXACT_DUPLICATE');
      }
      if (collision) {
        addIssue(member.recordIndex, {
          ruleCode: PREPARED_KEY_RULE_CODES.normalizationCollision, fieldPath: `data.${keyField}`, severity: 'warning', issueType: 'preparation',
          message: `Raw records [${peers}] differ but produce the same prepared ${keyField}; the difference was removed by normalization.`,
        }, 'NORMALIZATION_COLLISION');
      }
    }
  }
  groups.sort((a, b) => a.members[0].recordIndex - b.members[0].recordIndex);
  return { groups, issuesByRecord, kindsByRecord };
}

/** Appends the findings' issues to the matching records; a record becomes invalid only through an error-severity issue (CONFLICT). */
export function mergeKeyFindingsIntoValidation(
  validation: BatchValidationOutcome,
  issuesByRecord: ReadonlyMap<number, RecordValidationIssue[]>
): BatchValidationOutcome {
  if (issuesByRecord.size === 0) return validation;
  const records = validation.records.map((outcome) => {
    const extra = issuesByRecord.get(outcome.recordIndex);
    if (!extra || !outcome.isValid) return outcome;
    const issues = [...outcome.issues, ...extra];
    const errorCount = issues.filter((i) => i.severity === 'error').length;
    return { ...outcome, issues, errorCount, warningCount: issues.length - errorCount, isValid: errorCount === 0 };
  });
  return {
    records,
    totalErrorCount: records.reduce((n, r) => n + r.errorCount, 0),
    totalWarningCount: records.reduce((n, r) => n + r.warningCount, 0),
    duplicateRecordIndexes: validation.duplicateRecordIndexes,
    allValid: records.every((r) => r.isValid),
  };
}
