/** Compare tenant row counts while keeping schema disappearance visible. */
export function changedTenantRows(before: Record<string, number>, after: Record<string, number>): Record<string, string> {
  return Object.fromEntries(
    [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((table) => !Object.hasOwn(after, table) || after[table] !== (before[table] ?? 0))
      .map((table) => [table, Object.hasOwn(after, table)
        ? `${before[table] ?? 0} -> ${after[table]}`
        : `${before[table]} -> missing`]),
  );
}

/**
 * Tables that tests create and drop in the SHARED CI database (the erasure tests build `business_operations.erasure_*_fixture`). Turbo runs the
 * packages' test suites in parallel against one database, so a snapshot that lists or counts such a table can see it vanish mid-snapshot
 * (`relation ... does not exist`, or `0 -> missing`). They are not product schema: the architecture test in `tenantRowCountDiff.test.ts` proves no
 * migration defines a table with this suffix, so excluding them cannot hide a product table from an isolation proof.
 */
export const TEST_FIXTURE_TABLE_SUFFIX = '_fixture';
export const isTestFixtureTable = (qualifiedName: string): boolean => qualifiedName.endsWith(TEST_FIXTURE_TABLE_SUFFIX);

