import { describe, expect, it } from 'vitest';
import { OperationalRecordPreparer, mergePreparationIntoValidation } from '../src/preparation/OperationalRecordPreparer.js';
import { detectPreparedKeyFindings, mergeKeyFindingsIntoValidation } from '../src/preparation/preparedKeyFindings.js';
import { ManualRecordValidator } from '../src/validation/ManualRecordValidator.js';
import { hashRecord } from '../src/provenance/ProvenanceService.js';

const preparer = new OperationalRecordPreparer();
const item = (data: Record<string, unknown>) => ({ recordType: 'inventory_item', data: { sku: 'A-1', name: 'Widget', ...data } });
const wh = (data: Record<string, unknown>) => ({ recordType: 'warehouse', data: { warehouseCode: 'W-1', name: 'Main', ...data } });
const move = (data: Record<string, unknown>) => ({ recordType: 'inventory_movement', data: { sku: 'A-1', warehouseCode: 'W-1', movementType: 'receipt', quantity: 1, ...data } });

function run(records: unknown[]) {
  const outcomes = preparer.prepareBatch(records);
  return detectPreparedKeyFindings(toCandidates(records, outcomes));
}
function toCandidates(records: unknown[], outcomes: ReturnType<typeof preparer.prepareBatch>) {
  return outcomes.flatMap((o) => {
    if (!o.prepared) return [];
    const raw = records[o.recordIndex] as { data: Record<string, unknown> };
    const key = raw.data[o.prepared.recordType === 'warehouse' ? 'warehouseCode' : 'sku'];
    return [{ recordIndex: o.recordIndex, prepared: o.prepared, rawHash: hashRecord(raw), preparedHash: hashRecord(o.prepared), rawKeyText: typeof key === 'string' ? key : null }];
  });
}
const codesFor = (f: ReturnType<typeof run>, i: number) => (f.issuesByRecord.get(i) ?? []).map((x) => x.ruleCode);

describe('EXACT_DUPLICATE: warning only, every record kept', () => {
  it('identical items', () => {
    const f = run([item({}), item({})]);
    expect(f.groups).toHaveLength(1);
    expect(f.groups[0]).toMatchObject({ kind: 'EXACT_DUPLICATE', recordType: 'inventory_item', keyField: 'sku', differingFields: [], normalizationCollision: false });
    expect(f.groups[0].members.map((m) => m.recordIndex)).toEqual([0, 1]);
    for (const i of [0, 1]) {
      expect(codesFor(f, i)).toEqual(['PREP_EXACT_DUPLICATE']);
      expect(f.issuesByRecord.get(i)![0].severity).toBe('warning');
    }
  });
  it('identical warehouses, three copies', () => {
    const f = run([wh({}), wh({}), wh({})]);
    expect(f.groups).toHaveLength(1);
    expect(f.groups[0].members).toHaveLength(3);
    expect(f.groups[0].kind).toBe('EXACT_DUPLICATE');
  });
  it('later record that states no unitOfMeasure never conflicts (BO ignores an absent one)', () => {
    expect(run([item({ unitOfMeasure: 'each' }), item({})]).groups[0].kind).toBe('EXACT_DUPLICATE');
  });
  it('anchor without unitOfMeasure and later "unit" is the same stored value, so a duplicate', () => {
    expect(run([item({}), item({ unitOfMeasure: 'unit' })]).groups[0].kind).toBe('EXACT_DUPLICATE');
  });
});

describe('CONFLICT: error on every member', () => {
  it('same sku, different name', () => {
    const f = run([item({}), item({ name: 'Other' })]);
    expect(f.groups[0]).toMatchObject({ kind: 'CONFLICT', differingFields: ['name'] });
    for (const i of [0, 1]) {
      expect(codesFor(f, i)).toEqual(['PREP_CONFLICT']);
      expect(f.issuesByRecord.get(i)![0].severity).toBe('error');
    }
  });
  it('same sku, different unitOfMeasure; and anchor without one versus a later explicit different one', () => {
    expect(run([item({ unitOfMeasure: 'each' }), item({ unitOfMeasure: 'box' })]).groups[0]).toMatchObject({ kind: 'CONFLICT', differingFields: ['unitOfMeasure'] });
    expect(run([item({}), item({ unitOfMeasure: 'each' })]).groups[0]).toMatchObject({ kind: 'CONFLICT', differingFields: ['unitOfMeasure'] });
  });
  it('same warehouseCode, different name', () => {
    expect(run([wh({}), wh({ name: 'Annex' })]).groups[0]).toMatchObject({ kind: 'CONFLICT', recordType: 'warehouse', keyField: 'warehouseCode', differingFields: ['name'] });
  });
  it('a conflict anywhere in a group marks the whole group, including a harmless duplicate in it', () => {
    const f = run([item({}), item({}), item({ name: 'Other' })]);
    expect(f.groups).toHaveLength(1);
    expect(f.groups[0].kind).toBe('CONFLICT');
    for (const i of [0, 1, 2]) expect(codesFor(f, i)).toContain('PREP_CONFLICT');
  });
  it('findings carry field names and positions, never values', () => {
    const f = run([item({ name: 'SECRET-NAME-1' }), item({ name: 'SECRET-NAME-2' })]);
    const everything = JSON.stringify([f.groups, [...f.issuesByRecord.values()]]);
    expect(everything).not.toContain('SECRET-NAME');
    expect(everything).not.toContain('A-1');
  });
});

describe('NORMALIZATION_COLLISION', () => {
  it('different raw records, same prepared key: reported alongside the duplicate', () => {
    const f = run([item({}), item({ sku: '  A-1 ' })]);
    expect(f.groups[0]).toMatchObject({ kind: 'EXACT_DUPLICATE', normalizationCollision: true });
    expect(f.groups[0].members[0].rawHash).not.toBe(f.groups[0].members[1].rawHash);
    expect(f.groups[0].members[0].preparedHash).toBe(f.groups[0].members[1].preparedHash);
    for (const i of [0, 1]) expect(codesFor(f, i)).toEqual(['PREP_EXACT_DUPLICATE', 'PREP_NORMALIZATION_COLLISION']);
  });
  it('NFC collision on a conflicting group is reported with the conflict', () => {
    const f = run([item({ name: 'Café' }), item({ name: 'Café', sku: 'A-1 ' })]);
    expect(f.groups[0]).toMatchObject({ kind: 'EXACT_DUPLICATE', normalizationCollision: true });
    const g = run([item({}), item({ sku: ' A-1', name: 'Different' })]);
    expect(g.groups[0]).toMatchObject({ kind: 'CONFLICT', normalizationCollision: true });
    expect(codesFor(g, 1)).toEqual(['PREP_CONFLICT', 'PREP_NORMALIZATION_COLLISION']);
  });
  it('a real disagreement is not a collision: raw records differ because they conflict, not because normalization erased anything', () => {
    const f = run([item({}), item({ name: 'Other' })]);
    expect(f.groups[0]).toMatchObject({ kind: 'CONFLICT', normalizationCollision: false });
    expect(codesFor(f, 0)).toEqual(['PREP_CONFLICT']);
  });
  it('whitespace-only difference in a non-key field that normalization removes is a collision', () => {
    expect(run([item({}), item({ name: ' Widget ' })]).groups[0]).toMatchObject({ kind: 'EXACT_DUPLICATE', normalizationCollision: true });
  });
  it('byte-identical raw duplicates are NOT a collision', () => {
    expect(run([item({}), item({})]).groups[0].normalizationCollision).toBe(false);
  });
});

describe('what is deliberately not a finding', () => {
  it('keys that differ only by case stay distinct (BO identifiers are case-sensitive)', () => {
    expect(run([item({ sku: 'sku-1' }), item({ sku: 'SKU-1' })]).groups).toEqual([]);
    expect(run([wh({ warehouseCode: 'w-1' }), wh({ warehouseCode: 'W-1' })]).groups).toEqual([]);
  });
  it('inventory movements are never classified, even when identical', () => {
    const f = run([move({}), move({}), move({ quantity: 2 })]);
    expect(f.groups).toEqual([]);
    expect(f.issuesByRecord.size).toBe(0);
  });
  it('an item and a warehouse with the same text are different identities', () => {
    expect(run([item({ sku: 'X-1' }), wh({ warehouseCode: 'X-1' })]).groups).toEqual([]);
  });
  it('rejected records do not take part', () => {
    expect(run([item({}), item({ sku: 'bad sku!' })]).groups).toEqual([]);
  });
  it('unique keys produce nothing', () => {
    expect(run([item({ sku: 'A' }), item({ sku: 'B' }), wh({})]).groups).toEqual([]);
  });
});

describe('determinism and no mutation', () => {
  const batch = [item({}), wh({}), item({ name: 'Other' }), wh({}), item({ sku: 'Z' }), wh({ name: 'Annex' })];
  it('same input, same output, groups ordered by anchor and members ascending', () => {
    const a = run(batch); const b = run(batch);
    expect(JSON.stringify([a.groups, [...a.issuesByRecord]])).toBe(JSON.stringify([b.groups, [...b.issuesByRecord]]));
    expect(a.groups.map((g) => g.groupId)).toEqual(['inventory_item#0', 'warehouse#1']);
    for (const g of a.groups) expect(g.members.map((m) => m.recordIndex)).toEqual([...g.members.map((m) => m.recordIndex)].sort((x, y) => x - y));
  });
  it('candidate order does not matter: the detector orders by record index itself', () => {
    const candidates = toCandidates(batch, preparer.prepareBatch(batch));
    const forward = detectPreparedKeyFindings(candidates);
    const reversed = detectPreparedKeyFindings([...candidates].reverse());
    expect(JSON.stringify(reversed.groups)).toBe(JSON.stringify(forward.groups));
  });
  it('does not mutate its input', () => {
    const outcomes = preparer.prepareBatch(batch);
    const candidates = outcomes.map((o) => ({ recordIndex: o.recordIndex, prepared: o.prepared!, rawHash: 'r', preparedHash: 'p', rawKeyText: null }));
    const snapshot = JSON.stringify(candidates);
    detectPreparedKeyFindings(candidates);
    expect(JSON.stringify(candidates)).toBe(snapshot);
  });
});

describe('mergeKeyFindingsIntoValidation', () => {
  it('a duplicate keeps every record valid; a conflict invalidates the whole group and the batch', () => {
    const dup = [item({}), item({})];
    const conflict = [item({}), item({ name: 'Other' }), wh({})];
    for (const [records, allValid, validity] of [[dup, true, [true, true]], [conflict, false, [false, false, true]]] as const) {
      const structural = new ManualRecordValidator().validateBatch([...records]);
      const afterPrep = mergePreparationIntoValidation(structural, preparer.prepareBatch([...records]));
      const f = run([...records]);
      const merged = mergeKeyFindingsIntoValidation(afterPrep, f.issuesByRecord);
      expect(merged.allValid).toBe(allValid);
      expect(merged.records.map((r) => r.isValid)).toEqual(validity);
      expect(merged.totalErrorCount).toBe(merged.records.reduce((n, r) => n + r.errorCount, 0));
      expect(merged.totalWarningCount).toBe(merged.records.reduce((n, r) => n + r.warningCount, 0));
    }
  });
  it('returns the same object when there are no findings', () => {
    const structural = new ManualRecordValidator().validateBatch([item({})]);
    expect(mergeKeyFindingsIntoValidation(structural, new Map())).toBe(structural);
  });
});
