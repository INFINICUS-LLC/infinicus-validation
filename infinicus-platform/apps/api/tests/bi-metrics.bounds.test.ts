/** BI-2-DEV-03-R3: the API request schema and the read repository must agree on the read bounds (no database needed). If they ever diverge, one layer is silently looser. */
import { describe, expect, it } from 'vitest';
import { METRIC_READ_BOUNDS as B } from '@infinicus/database';
import { biMetricBusinessParamsSchema, biMetricDetailQuerySchema, biMetricListQuerySchema } from '../src/schemas/biMetrics.js';

const accepts = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: Record<string, unknown>) => schema.safeParse(value).success;

describe('API request schema and repository agree on the read bounds', () => {
  it('limit', () => {
    expect(accepts(biMetricListQuerySchema, { limit: B.minLimit })).toBe(true);
    expect(accepts(biMetricListQuerySchema, { limit: B.maxLimit })).toBe(true);
    expect(accepts(biMetricListQuerySchema, { limit: B.minLimit - 1 })).toBe(false);
    expect(accepts(biMetricListQuerySchema, { limit: B.maxLimit + 1 })).toBe(false);
  });
  it('offset', () => {
    expect(accepts(biMetricListQuerySchema, { offset: B.minOffset })).toBe(true);
    expect(accepts(biMetricListQuerySchema, { offset: B.maxOffset })).toBe(true);
    expect(accepts(biMetricListQuerySchema, { offset: B.minOffset - 1 })).toBe(false);
    expect(accepts(biMetricListQuerySchema, { offset: B.maxOffset + 1 })).toBe(false);
  });
  it('versionLimit', () => {
    expect(accepts(biMetricDetailQuerySchema, { versionLimit: B.minVersionLimit })).toBe(true);
    expect(accepts(biMetricDetailQuerySchema, { versionLimit: B.maxVersionLimit })).toBe(true);
    expect(accepts(biMetricDetailQuerySchema, { versionLimit: B.minVersionLimit - 1 })).toBe(false);
    expect(accepts(biMetricDetailQuerySchema, { versionLimit: B.maxVersionLimit + 1 })).toBe(false);
  });
  it('the schema is stricter in no direction that matters here: fractional values are refused by both layers', () => {
    expect(accepts(biMetricListQuerySchema, { limit: 7.5 })).toBe(false);
    expect(accepts(biMetricDetailQuerySchema, { versionLimit: 7.5 })).toBe(false);
  });
});

/** The identifier rules stated in docs/bi-metric-registry-read-api.md, pinned so a Zod change that alters them fails here and the document is revisited. */
describe('the documented API identifier rule (Zod 4 uuid) is what the schema actually does', () => {
  const parse = (businessId: string) => biMetricBusinessParamsSchema.safeParse({ businessId });
  it('accepts either letter case and returns the lower-case form', () => {
    const r = parse('3F2504E0-4F89-41D3-9A0C-0305E82C3301');
    expect(r.success && r.data.businessId).toBe('3f2504e0-4f89-41d3-9a0c-0305e82c3301');
    expect(parse('3f2504e0-4f89-41d3-9a0c-0305e82c3301').success).toBe(true);
  });
  it('enforces version 1 to 8 and variant 8, 9, a or b', () => {
    for (const v of ['1', '4', '8']) expect(parse(`3f2504e0-4f89-${v}1d3-9a0c-0305e82c3301`).success, `version ${v}`).toBe(true);
    for (const v of ['0', '9']) expect(parse(`3f2504e0-4f89-${v}1d3-9a0c-0305e82c3301`).success, `version ${v}`).toBe(false);
    for (const v of ['8', '9', 'a', 'b', 'A']) expect(parse(`3f2504e0-4f89-41d3-${v}a0c-0305e82c3301`).success, `variant ${v}`).toBe(true);
    for (const v of ['0', '7', 'c', 'f']) expect(parse(`3f2504e0-4f89-41d3-${v}a0c-0305e82c3301`).success, `variant ${v}`).toBe(false);
  });
  it('refuses a well-formed hexadecimal id that has no valid version or variant', () => {
    expect(parse('11111111-2b2b-0000-0000-000000000001').success).toBe(false);
  });
  it('accepts the nil UUID, and the all-ones UUID in lower case only', () => {
    expect(parse('00000000-0000-0000-0000-000000000000').success).toBe(true);
    expect(parse('ffffffff-ffff-ffff-ffff-ffffffffffff').success).toBe(true);
    expect(parse('FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF').success).toBe(false);
  });
  it('refuses non-canonical forms', () => {
    for (const v of ['{3f2504e0-4f89-41d3-9a0c-0305e82c3301}', '3f2504e04f8941d39a0c0305e82c3301', 'urn:uuid:3f2504e0-4f89-41d3-9a0c-0305e82c3301', ' 3f2504e0-4f89-41d3-9a0c-0305e82c3301', '3f2504e0-4f89-41d3-9a0c-0305e82c3301\n', '3f2504e0-4f89-41d3-9a0c-0305e82c33010', 'not-a-uuid', '']) {
      expect(parse(v).success, JSON.stringify(v)).toBe(false);
    }
  });
});
