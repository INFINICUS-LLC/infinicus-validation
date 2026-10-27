import { describe, expect, it } from 'vitest';
import { changedTenantRows } from './helpers/tenantRowCountDiff.js';

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
