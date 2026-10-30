#!/usr/bin/env node
// BUILD-26 — Right-to-erasure: permanently deletes one tenant's entire
// data footprint. Reuses the exact same tenant-scoped-table discovery
// mechanism as export-tenant.sh (BUILD-22) — every table with an RLS
// policy referencing app.tenant_id — so this script never drifts out of
// sync with export-tenant.sh's own notion of "which tables are a
// tenant's data" as new domains are added.
//
// Deletion order matters: most FKs in this schema are ON DELETE
// RESTRICT (deliberately — see every migration's own FK definitions),
// so a naive DELETE in table-discovery order would fail on the first
// table another table still references. This script computes a real
// topological sort from pg_constraint's actual FK graph, restricted to
// the discovered tenant-scoped table set, and deletes children before
// the parents they reference.
//
// Drives psql via child_process rather than the `pg` npm driver — this
// script lives under infrastructure/, not inside a workspace package,
// so it has no node_modules of its own; every other script in this
// directory (export-tenant.sh, grant-app-role.sh, backup.sh, ...) is
// psql-based for the same reason.
//
// Tables in ADMIN_ERASED_TABLES (AUDIT-LP-1) are the exception: the application role cannot delete from them, so their rows for the tenant are
// removed over the admin connection with an explicit tenant predicate.
// All tenant-scoped deletes run through the RLS-restricted role with
// app.tenant_id set (DELETE FROM <table>, no WHERE needed — RLS already
// scopes it to exactly that tenant, the same safety property
// export-tenant.sh relies on: even a bug in this script's own logic
// cannot delete another tenant's rows). tenancy.tenants/workspaces
// themselves are not tenant-scoped tables (they ARE the tenant
// identity) and are deleted last via an elevated connection.
//
// Usage:
//   DATABASE_URL="postgresql://app_test_user:pw@host:5432/db" \
//   ADMIN_DATABASE_URL="postgresql://admin_role:pw@host:5432/db" \
//   TENANT_ID="<uuid>" \
//   DELETED_BY="<actor>" \
//     node delete-tenant-data.mjs
//
// Exit code: 0 on success (prints the deletion order and per-table row
// counts), non-zero on any failure.

import { execFileSync } from 'node:child_process';

class ErasureError extends Error {}

const DATABASE_FAILURE = 'Database operation failed (details withheld)';

function runPsql(connectionString, args, input) {
  try {
    // Explicit pipes also suppress execFileSync's automatic stderr forwarding
    // on failure. Never expose child output, connection arguments or causes.
    return execFileSync('psql', [connectionString, ...args], {
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], input,
    });
  } catch {
    throw new ErasureError(DATABASE_FAILURE);
  }
}

function psql(connectionString, sql, args = []) {
  return runPsql(connectionString, ['-tAc', sql, ...args]);
}

function psqlTransaction(connectionString, statements) {
  const script = ['\\set ON_ERROR_STOP on', 'BEGIN;', ...statements, 'COMMIT;'].join('\n');
  return runPsql(connectionString, ['-v', 'ON_ERROR_STOP=1'], script);
}

// Read-only count batching. Each count is emitted as `CNT|<index>|<count>` and matched back to its table by index, never by position or by guessing.
// A missing, repeated or non-numeric result is an error: a count that could not be read is never reported as zero.
function parseCountLines(output, expected, what) {
  const counts = new Array(expected).fill(null);
  for (const line of output.split('\n').map((value) => value.trim())) {
    const match = /^CNT\|(\d+)\|(\d+)$/.exec(line);
    if (!match) continue; // set_config() echoes its value into the output of a scoped session
    const index = Number(match[1]);
    const count = Number(match[2]);
    if (index >= expected || counts[index] !== null || !Number.isSafeInteger(count) || count < 0) throw new Error(`Invalid ${what} count result`);
    counts[index] = count;
  }
  if (counts.some((count) => count === null)) throw new Error(`Missing ${what} count result`);
  return counts;
}

// AUDIT-LP-1: tables whose rows the APPLICATION role may no longer update, delete or truncate (see grant-app-role.sh). This tenant's rows in them are
// erased over the ADMIN connection instead, always with an explicit `tenant_id = <tenant>` predicate. Rows with a NULL tenant_id (shared
// pre-authentication events) belong to no tenant and are never touched. A table listed here that lacks a literal tenant_id column is reported as
// blocked; the script never issues a blanket DELETE over the admin connection.
const ADMIN_ERASED_TABLES = new Set(['audit.access_events']);

function databaseFailureReason() {
  // Used in partial-erasure output AND the persisted audit record. Database
  // error text can contain credentials or row payloads, even after "ERROR:".
  return DATABASE_FAILURE;
}

async function main() {
  const { DATABASE_URL, ADMIN_DATABASE_URL, TENANT_ID, DELETED_BY } = process.env;
  if (!DATABASE_URL) throw new ErasureError('DATABASE_URL is required');
  if (!ADMIN_DATABASE_URL) throw new ErasureError('ADMIN_DATABASE_URL is required');
  if (!TENANT_ID) throw new ErasureError('TENANT_ID is required');
  // Accept PostgreSQL UUID values only in canonical 8-4-4-4-12 hex form.
  // Length also rejects a trailing newline (which a regexp $ can accept).
  // Do not trim, coerce or echo rejected input. This runs before ANY psql.
  if (TENANT_ID.length !== 36 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(TENANT_ID)) {
    throw new ErasureError('TENANT_ID must be a canonical UUID');
  }
  const deletedBy = (DELETED_BY ?? 'unknown').replace(/'/g, "''");

  const isRlsExempt = psql(DATABASE_URL, 'SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user;').trim();
  if (isRlsExempt === 't') {
    throw new ErasureError(
      "DATABASE_URL connects as a role that bypasses row-level security (superuser or BYPASSRLS) — refusing to run, since a bug in this script could then delete every tenant's data instead of just TENANT_ID's. Use the RLS-restricted application role."
    );
  }

  console.log('Discovering tenant-scoped tables (RLS policies referencing app.tenant_id) ...');
  const tablesRaw = psql(
    ADMIN_DATABASE_URL,
    "SELECT DISTINCT schemaname || '.' || tablename FROM pg_policies WHERE qual LIKE '%app.tenant_id%' ORDER BY 1;"
  );
  // tenancy.tenants matches this discovery query too (its own RLS policy
  // is `id = current_setting('app.tenant_id', true)::uuid` — the text
  // "app.tenant_id" appears, but the compared column is `id`, not a
  // `tenant_id` column tenants doesn't have). It's handled explicitly,
  // separately, below — excluded here to avoid double-processing.
  const tenantScopedTables = new Set(
    tablesRaw.split('\n').map((l) => l.trim()).filter(Boolean).filter((t) => t !== 'tenancy.tenants')
  );
  console.log(`Found ${tenantScopedTables.size} tenant-scoped tables.`);

  // SAFETY CHECK: some of these tables' RLS policies use a nullable-
  // tenant pattern (`tenant_id IS NULL OR tenant_id = current_setting(...)`)
  // to make platform-shared rows visible to every tenant (e.g.
  // tenancy.roles' system roles, audit.access_events/
  // observability.error_events' pre-auth events — see BUILD-18/25's own
  // repository doc comments). Relying on RLS visibility ALONE for a
  // blanket `DELETE FROM table` would therefore also delete every OTHER
  // tenant's shared rows through that OR-NULL branch — a real,
  // catastrophic cross-tenant bug this build's own live testing caught
  // (tenancy.roles' system roles blocked deletion via a still-referencing
  // membership_roles row belonging to a DIFFERENT tenant, revealing that
  // this script would otherwise have tried to delete every tenant's
  // shared system roles). Fixed by adding an explicit
  // `WHERE tenant_id = '<TENANT_ID>'` to every table that has a literal
  // tenant_id column (the overwhelming majority) — this always targets
  // only the current tenant's own rows regardless of what RLS
  // additionally admits as visible. The rare few tables scoped
  // indirectly (no literal tenant_id column — e.g.
  // identity.api_key_references, scoped via its owning service
  // account's tenant) keep a blanket DELETE, since their RLS policy
  // itself only ever admits exactly the current tenant's rows (no
  // OR-NULL fallback) — verified per-table, not assumed.
  const columnCheckRaw = psql(
    ADMIN_DATABASE_URL,
    `SELECT schemaname||'.'||tablename FROM pg_policies p
     WHERE qual LIKE '%app.tenant_id%' AND schemaname||'.'||tablename <> 'tenancy.tenants'
       AND EXISTS (
         SELECT 1 FROM information_schema.columns c
         WHERE c.table_schema = p.schemaname AND c.table_name = p.tablename AND c.column_name = 'tenant_id'
       );`
  );
  const tablesWithTenantIdColumn = new Set(columnCheckRaw.split('\n').map((l) => l.trim()).filter(Boolean));
  const tablesScopedIndirectly = [...tenantScopedTables].filter((t) => !tablesWithTenantIdColumn.has(t));
  if (tablesScopedIndirectly.length > 0) {
    console.log(`Tables scoped indirectly (no literal tenant_id column, blanket DELETE relies on RLS): ${tablesScopedIndirectly.join(', ')}`);
  }

  // SAFETY CHECK #2 (found live during BUILD-27 performance testing):
  // most tenant-scoped tables' RLS policy ANDs a SECOND predicate —
  // `workspace_id = current_setting('app.workspace_id', true)::uuid` —
  // not just tenant_id. Setting only app.tenant_id (as this script did
  // originally) leaves that second predicate comparing against NULL for
  // every one of those tables, so RLS silently admits zero rows and every
  // DELETE against them affects nothing — no error, just orphaned data
  // that later breaks a FK constraint on some other table (which is
  // exactly how this was caught: a leftover simulation_model_versions row
  // blocked deletion of its parent business). Tables requiring
  // app.workspace_id must be deleted once per workspace the tenant owns,
  // with both session variables set for each pass.
  const workspaceScopedCheckRaw = psql(
    ADMIN_DATABASE_URL,
    `SELECT DISTINCT schemaname||'.'||tablename FROM pg_policies
     WHERE qual LIKE '%app.tenant_id%' AND qual LIKE '%app.workspace_id%';`
  );
  const tablesRequiringWorkspaceScope = new Set(workspaceScopedCheckRaw.split('\n').map((l) => l.trim()).filter(Boolean));

  const workspaceColumnCheckRaw = psql(
    ADMIN_DATABASE_URL,
    `SELECT schemaname||'.'||tablename FROM pg_policies p
     WHERE qual LIKE '%app.workspace_id%'
       AND EXISTS (
         SELECT 1 FROM information_schema.columns c
         WHERE c.table_schema = p.schemaname AND c.table_name = p.tablename AND c.column_name = 'workspace_id'
       );`
  );
  const tablesWithWorkspaceIdColumn = new Set(workspaceColumnCheckRaw.split('\n').map((l) => l.trim()).filter(Boolean));

  const workspaceIdsRaw = psql(ADMIN_DATABASE_URL, `SELECT id FROM tenancy.workspaces WHERE tenant_id = '${TENANT_ID}';`);
  const workspaceIds = workspaceIdsRaw.split('\n').map((l) => l.trim()).filter(Boolean);
  console.log(`Found ${tablesRequiringWorkspaceScope.size} tables requiring per-workspace scoping across ${workspaceIds.length} workspace(s).`);

  // SAFETY CHECK #3 (found live during BUILD-27): a large subset of
  // tenant-scoped tables across every domain (intake status-history,
  // run status-history, versions, evidence, deployment-rollback tables,
  // ...) carry a BEFORE UPDATE OR DELETE trigger calling
  // <schema>.forbid_mutation(), which unconditionally RAISEs — these are
  // deliberately append-only audit-trail tables (the same immutability
  // guarantee BUILD-23/24's own deployment/secret-rotation audit tables
  // rely on), and no role, including this script's, can DELETE from
  // them. A tenant with real usage history in these domains therefore
  // cannot have every one of its rows physically erased without either
  // compromising that audit-trail integrity guarantee or building a
  // dedicated anonymization capability — neither of which is in scope
  // here. This script's honest, safe behavior is to skip these tables
  // entirely (never attempt the DELETE, since the trigger would abort
  // the whole surrounding transaction) and report them as retained, so
  // a caller can see exactly what was and was not erased rather than
  // the script silently claiming full erasure or crashing outright.
  // Migration 0196 activation and 0213 governed OM sources use their own
  // unconditional mutation-refusal functions and remain protected even when
  // the application role has no DELETE privilege.
  const appendOnlyRaw = psql(
    ADMIN_DATABASE_URL,
    `SELECT DISTINCT n.nspname||'.'||c.relname
     FROM pg_trigger t
     JOIN pg_class c ON c.oid = t.tgrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE p.proname IN ('forbid_mutation', 'forbid_execution_capability_activation_mutation',
                        'forbid_governed_source_mutation');`
  );
  const tablesAppendOnly = new Set(
    appendOnlyRaw.split('\n').map((l) => l.trim()).filter(Boolean).filter((t) => tenantScopedTables.has(t))
  );
  if (tablesAppendOnly.size > 0) {
    console.log(`${tablesAppendOnly.size} tables are append-only audit trail (forbid_mutation trigger) — will be retained, not deleted.`);
  }

  console.log('Computing FK dependency order ...');
  const fkRaw = psql(
    ADMIN_DATABASE_URL,
    `SELECT (tc_ns.nspname || '.' || tc.relname) || '|' || (fc_ns.nspname || '.' || fc.relname)
     FROM pg_constraint c
     JOIN pg_class tc ON tc.oid = c.conrelid
     JOIN pg_namespace tc_ns ON tc_ns.oid = tc.relnamespace
     JOIN pg_class fc ON fc.oid = c.confrelid
     JOIN pg_namespace fc_ns ON fc_ns.oid = fc.relnamespace
     WHERE c.contype = 'f';`
  );

  // Kahn's algorithm: a table can be deleted once every table that
  // references it (its dependents) has already been deleted.
  const dependents = new Map();
  for (const t of tenantScopedTables) dependents.set(t, new Set());
  for (const line of fkRaw.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const [from, to] = line.split('|');
    if (tenantScopedTables.has(from) && tenantScopedTables.has(to) && from !== to) {
      dependents.get(to).add(from);
    }
  }

  const deletedSet = new Set();
  const order = [];
  while (order.length < tenantScopedTables.size) {
    let progressed = false;
    for (const table of tenantScopedTables) {
      if (deletedSet.has(table)) continue;
      const blockers = [...dependents.get(table)].filter((d) => !deletedSet.has(d));
      if (blockers.length === 0) {
        order.push(table);
        deletedSet.add(table);
        progressed = true;
      }
    }
    if (!progressed) {
      const remaining = [...tenantScopedTables].filter((t) => !deletedSet.has(t));
      throw new Error(`Cyclic FK dependency detected among tenant-scoped tables, cannot compute a safe delete order: ${remaining.join(', ')}`);
    }
  }

  console.log('Delete order:', order.join(' -> '));

  // Real per-table row counts for the audit record: one counting pass
  // (SELECT count(*)) before the deleting pass, both under the same
  // RLS-scoped tenant context, so the audit trail reports exactly how
  // many rows were actually removed per table, not a placeholder.
  function scopedClause(table, workspaceId) {
    let clause = tablesWithTenantIdColumn.has(table) ? ` WHERE tenant_id = '${TENANT_ID}'` : '';
    if (workspaceId && tablesWithWorkspaceIdColumn.has(table)) {
      clause += clause ? ` AND workspace_id = '${workspaceId}'` : ` WHERE workspace_id = '${workspaceId}'`;
    }
    return clause;
  }

  // Counts under the APPLICATION role with RLS context, exactly as before, but in at most two psql sessions instead of one process per table and
  // workspace. Every count keeps its own transaction (BEGIN ... COMMIT) so its transaction-local app.tenant_id / app.workspace_id exist only for that
  // count. Sessions are split by scope signature: once a session has set a custom variable, PostgreSQL keeps it as an EMPTY STRING (not unset) after the
  // transaction ends, and a policy that casts `current_setting('app.workspace_id', true)::uuid` would then fail instead of seeing NULL. The tenant-only
  // session therefore never sets app.workspace_id, and every count in the workspace session sets both variables itself. Any failure aborts the whole run.
  function countScopedRowsBatch(tables) {
    const totals = new Map(tables.map((table) => [table, 0]));
    const plan = [];
    for (const table of tables) {
      const scopes = tablesRequiringWorkspaceScope.has(table) ? workspaceIds : [null];
      for (const ws of scopes) plan.push({ table, ws });
    }
    for (const workspaceScoped of [false, true]) {
      const items = plan.filter((item) => (item.ws !== null) === workspaceScoped);
      if (items.length === 0) continue;
      const script = ['\\set ON_ERROR_STOP on'];
      items.forEach((item, index) => {
        script.push('BEGIN;', `SELECT set_config('app.tenant_id', '${TENANT_ID}', true);`);
        if (item.ws) script.push(`SELECT set_config('app.workspace_id', '${item.ws}', true);`);
        script.push(`SELECT 'CNT|${index}|' || count(*) FROM ${item.table}${scopedClause(item.table, item.ws)};`, 'COMMIT;');
      });
      const counts = parseCountLines(runPsql(DATABASE_URL, ['-tA', '-v', 'ON_ERROR_STOP=1'], script.join('\n')), items.length, 'scoped row');
      items.forEach((item, index) => totals.set(item.table, totals.get(item.table) + counts[index]));
    }
    for (const [table, total] of totals) if (!Number.isSafeInteger(total)) throw new Error(`Unsafe scoped row count for ${table}`);
    return totals;
  }

  // Counts over the ADMIN connection with an explicit tenant predicate (no RLS context involved): one UNION ALL, the same shape as the
  // remaining-rows check below.
  function countTenantRowsAdmin(tables) {
    const totals = new Map();
    if (tables.length === 0) return totals;
    const query = tables.map((table, index) => `SELECT 'CNT|${index}|' || count(*) FROM ${table} WHERE tenant_id = '${TENANT_ID}'`).join(' UNION ALL ') + ';';
    const counts = parseCountLines(runPsql(ADMIN_DATABASE_URL, ['-tA', '-v', 'ON_ERROR_STOP=1'], query), tables.length, 'retained row');
    tables.forEach((table, index) => totals.set(table, counts[index]));
    return totals;
  }

  const deletableOrder = order.filter((table) => !tablesAppendOnly.has(table));
  // AUDIT-LP-1: tables the application role cannot delete from are erased over the admin connection after the application-role pass.
  const adminErasedOrder = deletableOrder.filter((table) => ADMIN_ERASED_TABLES.has(table));
  const appRoleOrder = deletableOrder.filter((table) => !ADMIN_ERASED_TABLES.has(table));

  const rowCounts = {};
  const preDeleteCounts = countScopedRowsBatch(deletableOrder);
  for (const table of deletableOrder) {
    rowCounts[table] = preDeleteCounts.get(table);
  }

  // Each deletable table runs as its own short transaction rather than
  // one giant all-or-nothing transaction. This is necessary, not just
  // convenient: excluding append-only tables from `order` can still
  // leave a normal (deletable) table blocked by ON DELETE RESTRICT from
  // a retained append-only row that references it (e.g. an intake
  // package with real status-history rows this script must not touch).
  // Deleting table-by-table lets every table that CAN be removed be
  // removed, while a table that genuinely can't (blocked by retained
  // audit-trail rows) is reported honestly instead of rolling back
  // everything that already succeeded.
  const blockedTables = {};
  for (const table of appRoleOrder) {
    try {
      if (tablesRequiringWorkspaceScope.has(table)) {
        for (const ws of workspaceIds) {
          psqlTransaction(DATABASE_URL, [
            `SELECT set_config('app.tenant_id', '${TENANT_ID}', true);`,
            `SELECT set_config('app.workspace_id', '${ws}', true);`,
            `DELETE FROM ${table}${scopedClause(table, ws)};`,
          ]);
        }
      } else {
        psqlTransaction(DATABASE_URL, [
          `SELECT set_config('app.tenant_id', '${TENANT_ID}', true);`,
          `DELETE FROM ${table}${scopedClause(table)};`,
        ]);
      }
    } catch {
      blockedTables[table] = databaseFailureReason();
    }
  }
  for (const table of adminErasedOrder) {
    if (!tablesWithTenantIdColumn.has(table)) {
      blockedTables[table] = databaseFailureReason();
      continue;
    }
    try {
      psqlTransaction(ADMIN_DATABASE_URL, [`DELETE FROM ${table} WHERE tenant_id = '${TENANT_ID}';`]);
    } catch {
      blockedTables[table] = databaseFailureReason();
    }
  }

  console.log('Tenant-scoped table deletion complete:', JSON.stringify(rowCounts, null, 2));
  if (tablesAppendOnly.size > 0) {
    console.log('Retained (append-only audit trail, not deleted):', [...tablesAppendOnly].join(', '));
  }
  if (Object.keys(blockedTables).length > 0) {
    console.log('Could not delete (blocked by retained append-only dependents):', JSON.stringify(blockedTables, null, 2));
  }

  // The presence of an append-only table is not retained tenant data. Count
  // its actual scoped rows after the deletable pass and fail closed if any
  // remain. This also prevents a missing FK from producing false "complete".
  const retainedRowCounts = {};
  // The explicit tenant predicate also detects rows a workspace RLS policy might hide after a workspace was removed or mislinked.
  const retainedByTenantColumn = countTenantRowsAdmin([...tablesAppendOnly].filter((table) => tablesWithTenantIdColumn.has(table)));
  const retainedByScope = countScopedRowsBatch([...tablesAppendOnly].filter((table) => !tablesWithTenantIdColumn.has(table)));
  for (const table of tablesAppendOnly) {
    retainedRowCounts[table] = tablesWithTenantIdColumn.has(table) ? retainedByTenantColumn.get(table) : retainedByScope.get(table);
  }
  const retainedRows = Object.values(retainedRowCounts).reduce((sum, count) => sum + count, 0);
  if (!Number.isSafeInteger(retainedRows)) throw new Error('Unsafe retained row total');

  // Verify all remaining tenant rows, including deletable tables that RLS
  // might have hidden from the application role. One privileged SELECT batch
  // uses an explicit tenant predicate; it does not delete or bypass the
  // application role for any mutation.
  const directTables = [...tenantScopedTables].filter((table) => tablesWithTenantIdColumn.has(table));
  const remainingRaw = directTables.length === 0 ? '' : psql(ADMIN_DATABASE_URL,
    directTables.map((table) =>
      `SELECT '${table}' AS table_name, count(*)::bigint AS n FROM ${table} WHERE tenant_id = '${TENANT_ID}'`
    ).join(' UNION ALL '));
  const remainingRows = {};
  for (const line of remainingRaw.split('\n').map((value) => value.trim()).filter(Boolean)) {
    const [table, textCount] = line.split('|');
    const count = Number(textCount);
    if (!directTables.includes(table) || !Number.isSafeInteger(count) || count < 0) {
      throw new Error('Invalid remaining tenant row count');
    }
    if (count > 0) remainingRows[table] = count;
  }
  const indirectCounts = countScopedRowsBatch(tablesScopedIndirectly);
  for (const table of tablesScopedIndirectly) {
    const count = indirectCounts.get(table);
    if (count > 0) remainingRows[table] = count;
  }

  const tenantNameRaw = psql(ADMIN_DATABASE_URL, `SELECT name FROM tenancy.tenants WHERE id = '${TENANT_ID}';`).trim();
  const tenantName = tenantNameRaw.length > 0 ? tenantNameRaw.replace(/'/g, "''") : null;

  const auditPayload = {
    rowCounts,
    retainedAppendOnly: [...tablesAppendOnly],
    retainedRowCounts,
    remainingRows,
    blockedByRetainedDependents: blockedTables,
  };

  let tenantFullyDeleted = true;
  try {
    psqlTransaction(ADMIN_DATABASE_URL, [
      `DELETE FROM tenancy.workspaces WHERE tenant_id = '${TENANT_ID}';`,
      `DELETE FROM tenancy.tenants WHERE id = '${TENANT_ID}';`,
    ]);
  } catch {
    tenantFullyDeleted = false;
    console.log(`tenancy.tenants/workspaces could not be deleted (blocked by retained dependents): ${databaseFailureReason()}`);
  }

  psqlTransaction(ADMIN_DATABASE_URL, [
    `INSERT INTO platform.data_deletion_events (tenant_id, tenant_name, deleted_by, table_row_counts)
     VALUES ('${TENANT_ID}', ${tenantName ? `'${tenantName}'` : 'NULL'}, '${deletedBy}', '${JSON.stringify(auditPayload).replace(/'/g, "''")}'::jsonb);`,
  ]);

  if (tenantFullyDeleted && Object.keys(blockedTables).length === 0 && retainedRows === 0 && Object.keys(remainingRows).length === 0) {
    console.log(`Deleted tenant ${TENANT_ID} (${tenantName ?? 'unknown name'}).`);
  } else {
    console.log(
      `Partially erased tenant ${TENANT_ID} (${tenantName ?? 'unknown name'}): ${retainedRows} append-only row(s) remain across ${tablesAppendOnly.size} protected table(s), or other deletion was blocked (see platform.data_deletion_events for the full record).`
    );
  }
}

main().catch((err) => {
  console.error(err instanceof ErasureError ? err.message : 'Tenant erasure failed (details withheld)');
  process.exit(1);
});
