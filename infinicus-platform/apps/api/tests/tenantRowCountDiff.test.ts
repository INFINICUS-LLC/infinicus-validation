import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { changedTenantRows, isTestFixtureTable } from './helpers/tenantRowCountDiff.js';

describe('AC-3 tenant row-count snapshots', () => {
  it('accepts unchanged counts', () => {
    expect(changedTenantRows({ 'platform.orders': 2 }, { 'platform.orders': 2 })).toEqual({});
  });

  it('accepts a newly observed table only when its tenant row count is zero', () => {
    expect(changedTenantRows({}, { 'business_operations.erasure_retained_fixture': 0 })).toEqual({});
  });

  it('detects a newly observed table with tenant rows', () => {
    expect(changedTenantRows({}, { 'platform.unauthorized': 1 })).toEqual({ 'platform.unauthorized': '0 -> 1' });
  });

  it('detects growth in an existing tenant table', () => {
    expect(changedTenantRows({ 'platform.orders': 2 }, { 'platform.orders': 3 })).toEqual({ 'platform.orders': '2 -> 3' });
  });

  it('reports a disappearing table instead of omitting it', () => {
    expect(changedTenantRows({ 'platform.orders': 2 }, {})).toEqual({ 'platform.orders': '2 -> missing' });
  });
});

describe('AC-3 snapshots ignore test fixture tables of other suites (shared CI database)', () => {
  it('recognizes only names ending in _fixture, in any schema', () => {
    expect(isTestFixtureTable('business_operations.erasure_retained_fixture')).toBe(true);
    expect(isTestFixtureTable('business_operations.erasure_failure_fixture')).toBe(true);
    expect(isTestFixtureTable('platform.orders')).toBe(false);
    expect(isTestFixtureTable('platform.fixture_orders')).toBe(false);
    expect(isTestFixtureTable('audit.access_events')).toBe(false);
  });

  it('no committed migration creates a table named *_fixture, so the exclusion cannot hide a product table', () => {
    const dir = resolve(__dirname, '../../../infrastructure/database/migrations');
    const offenders: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql'))) {
      const sql = readFileSync(join(dir, file), 'utf8');
      for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w."]+)/gi)) {
        if (isTestFixtureTable(m[1].replace(/"/g, ''))) offenders.push(`${file}: ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

