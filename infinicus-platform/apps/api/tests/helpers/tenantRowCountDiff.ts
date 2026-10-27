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
