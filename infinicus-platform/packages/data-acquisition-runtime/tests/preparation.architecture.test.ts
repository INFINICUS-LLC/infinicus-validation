import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * R-01A architecture guard: the DAL preparation stage is pure. It prepares evidence; it does not decide, persist, call out, or reach into another
 * layer. Persistence stays in DataAcquisitionService's existing transaction; BO remains the only operational writer.
 */
const DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'preparation');
const files = readdirSync(DIR).filter((f) => f.endsWith('.ts')).map((f) => ({ f, code: readFileSync(join(DIR, f), 'utf8') }));
const strip = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('R-01A preparation stage purity', () => {
  it('exists', () => expect(files.map((x) => x.f).sort()).toEqual(['OperationalRecordPreparer.ts', 'exactDecimal.ts', 'operationalRecordProfile.ts', 'preparedKeyFindings.ts', 'referenceFormats.ts', 'textSafety.ts']));
  it('imports nothing but its own profile and DAL types (no database, pg, BO, fs, network)', () => {
    for (const { f, code } of files) {
      const specifiers = [...strip(code).matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
      for (const s of specifiers) expect(s, f).toMatch(/^\.\.?\//);
      expect(specifiers.filter((s) => s.includes('business-operations')), f).toEqual([]);
    }
  });
  it('has no clock, randomness, I/O or SQL, so the same input always yields the same output', () => {
    for (const { f, code } of files) {
      expect(strip(code), f).not.toMatch(/Date\.now|new Date\(\)|Math\.random|randomUUID|process\.env|fetch\(|SELECT\s|INSERT\s|UPDATE\s|DELETE\s|await /);
    }
  });
  it('never defaults or folds a currency', () => {
    const code = strip(files.find((x) => x.f === 'OperationalRecordPreparer.ts')!.code);
    expect(code).not.toMatch(/'USD'|"USD"|defaultCurrency|unitCostCurrency[^;\n]*(toUpperCase|toLowerCase|trim\()/);
  });
});
