import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * ARCHITECTURE GUARD (V-07 / SOT-09, reconciliation item P1-F):
 *
 *   Business Operations code never writes a Data Acquisition table.
 *
 * `data_acquisition.publication_deliveries` is Data Acquisition's record of delivering a package. Business Operations used to INSERT and UPDATE it from
 * BusinessIntakeService (a cross-layer write). The state transitions now live in the DAL-owned PublicationDeliveryRepository, and BO only asks that
 * repository to acknowledge or reject a handoff. The READS of the handoff's data path (the published package, its submissions and its provenance) now live in
 * the DAL-owned PublicationIntakeReader as well (V-07 residual), so BO code names no `data_acquisition.` relation at all.
 *
 * What it forbids in BO code: (1) any INSERT INTO / UPDATE / DELETE FROM / TRUNCATE / ALTER / DROP naming a `data_acquisition.` relation, and
 * (2) any reference at all to a `data_acquisition.` relation in code (reads included).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PLATFORM_ROOT = resolve(HERE, '..', '..', '..');

/** Roots that constitute Business Operations code, relative to infinicus-platform/ (same set as boIsolation.architecture.test.ts). */
const BO_CODE_ROOTS: readonly string[] = [
  'packages/business-operations-runtime/src',
  'packages/database/src/repositories/bo',
  'layers/business-operations/src',
  'layers/business-operations/blocks',
];

const WRITE_TO_DAL = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?|ALTER\s+TABLE|DROP\s+TABLE)\s+(?:ONLY\s+)?"?data_acquisition"?\s*\./i;

function listSource(dir: string): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return []; }
  return entries.flatMap((name) => {
    if (name === 'node_modules' || name === 'dist') return [];
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return listSource(full);
    return /\.(ts|tsx|js|mjs|cjs)$/.test(name) && !/\.d\.ts$/.test(name) ? [full] : [];
  });
}

/** Source text with line and block comments removed, so prose that names a table cannot trip (or hide) the scan. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

const ANY_DAL_RELATION = /"?data_acquisition"?\s*\.\s*"?[a-z_]+/i;

/** Lines of code (comments removed) that name a data_acquisition relation in any way, reads included. */
export function findDalReferences(text: string): string[] {
  const code = stripComments(text);
  return code.split('\n').filter((line) => ANY_DAL_RELATION.test(line)).map((line) => line.trim());
}

export function findDalWrites(text: string): string[] {
  const code = stripComments(text);
  return code.split('\n').filter((line) => WRITE_TO_DAL.test(line)).map((line) => line.trim());
}

describe('V-07: Business Operations does not write Data Acquisition tables', () => {
  const files = BO_CODE_ROOTS.flatMap((root) => listSource(join(PLATFORM_ROOT, root)));

  it('scans a non-trivial set of Business Operations source files', () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((f) => f.endsWith('BusinessIntakeService.ts'))).toBe(true);
  });

  it('no BO source file contains a write to a data_acquisition relation', () => {
    const offenders = files
      .map((file) => ({ file: relative(PLATFORM_ROOT, file), writes: findDalWrites(readFileSync(file, 'utf8')) }))
      .filter((r) => r.writes.length > 0);
    expect(offenders).toEqual([]);
  });

  it('no BO source file names a data_acquisition relation at all: the reads go through the DAL-owned PublicationIntakeReader', () => {
    const offenders = files
      .map((file) => ({ file: relative(PLATFORM_ROOT, file), references: findDalReferences(readFileSync(file, 'utf8')) }))
      .filter((r) => r.references.length > 0);
    expect(offenders).toEqual([]);
  });

  it('BusinessIntakeService takes its package, submissions and provenance only from the PublicationIntakeReader, inside the one intake transaction', () => {
    const code = stripComments(readFileSync(join(PLATFORM_ROOT, 'packages/business-operations-runtime/src/intake/BusinessIntakeService.ts'), 'utf8'));
    expect(code).toMatch(/PublicationIntakeReader/);
    for (const method of ['lockPackageOn', 'submissionsForCollectionRunOn', 'provenanceForCollectionRunOn']) expect(code, method).toMatch(new RegExp(`intakeReader\\.${method}\\(client,`));
    expect(code).not.toMatch(/client\.query/);       // BO's intake runs no SQL of its own on a Data Acquisition table; every read goes through the port
  });

  it('BusinessIntakeService acknowledges and rejects handoffs only through the DAL-owned PublicationDeliveryRepository', () => {
    const code = stripComments(readFileSync(join(PLATFORM_ROOT, 'packages/business-operations-runtime/src/intake/BusinessIntakeService.ts'), 'utf8'));
    expect(code).toMatch(/PublicationDeliveryRepository/);
    expect(code).toMatch(/beginLayerAttemptOn\(/);
    expect(code).toMatch(/markLayerDeliveredOn\(/);
    expect(code).toMatch(/recordLayerFailure\(/);
    expect(code).not.toMatch(/publication_deliveries/);
  });

  describe('the scanner itself (so a pass cannot be an artefact of a blind scan)', () => {
    it('detects a read of a data_acquisition relation, with quoting or spacing variations, and ignores comments and other schemas', () => {
      for (const sql of [
        'SELECT * FROM data_acquisition.publication_packages WHERE id = $1 FOR UPDATE',
        'select id from "data_acquisition".manual_submissions',
        'FROM data_acquisition .provenance_records',
      ]) {
        expect(findDalReferences(`const q = \`${sql}\`;`), sql).toHaveLength(1);
      }
      expect(findDalReferences('// reads data_acquisition.publication_packages through the port')).toEqual([]);
      expect(findDalReferences('SELECT * FROM business_operations.business_events')).toEqual([]);
    });

    it('detects each kind of write, in any case and with quoting or spacing variations', () => {
      for (const sql of [
        'INSERT INTO data_acquisition.publication_deliveries (a) VALUES (1)',
        'update   data_acquisition.publication_deliveries SET x = 1',
        'DELETE FROM data_acquisition.manual_submissions',
        'TRUNCATE TABLE data_acquisition.provenance_records',
        'ALTER TABLE data_acquisition.publication_packages ADD COLUMN z int',
        'insert into "data_acquisition".publication_packages (id) values ($1)',
        'UPDATE ONLY data_acquisition.publication_packages SET status = 1',
      ]) {
        expect(findDalWrites(`const q = \`${sql}\`;`), sql).toHaveLength(1);
      }
    });

    it('ignores reads, other schemas and comments that merely mention a table', () => {
      expect(findDalWrites('SELECT * FROM data_acquisition.publication_packages WHERE id = $1 FOR UPDATE')).toEqual([]);
      expect(findDalWrites('INSERT INTO business_operations.business_events (id) VALUES ($1)')).toEqual([]);
      expect(findDalWrites('// UPDATE data_acquisition.publication_deliveries is owned by DAL')).toEqual([]);
      expect(findDalWrites('/* INSERT INTO data_acquisition.x */ const a = 1;')).toEqual([]);
    });
  });
});
