import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';

const MIGRATIONS_DIR = resolve(
  __dirname,
  '../../../infrastructure/database/migrations'
);

function sql(filename: string): string {
  return readFileSync(resolve(MIGRATIONS_DIR, filename), 'utf8');
}

function sqlNorm(filename: string): string {
  return sql(filename).replace(/\s+/g, ' ');
}

// ── Migration ordering ────────────────────────────────────────────────────────

describe('migration ordering', () => {
  it('migration files are numerically ordered with no gaps', () => {
    const files = readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.sql'))
      .sort();
    // AUTH-LOCKOUT-1 isolated release candidate only: it carries 0220 on top of the deployed 0209 and deliberately
    // omits 0210-0219 (docs/production-readiness/auth-lockout-1-rp-06/). That single gap is tolerated, and only
    // when ALL of 0210-0219 are absent; if any of them is present the numbering must be fully contiguous, as on main.
    const present = new Set(files.map(f => Number(f.slice(0, 4))));
    const documentedGapAbsent = Array.from({ length: 10 }, (_, k) => 210 + k).every(n => !present.has(n));
    let next = 1;
    for (let i = 0; i < files.length; i++) {
      if (documentedGapAbsent && next === 210) next = 220;
      const expected = String(next).padStart(4, '0');
      expect(files[i], `gap or disorder at position ${i + 1}`).toMatch(
        new RegExp(`^${expected}_`)
      );
      next++;
    }
  });

  it('all migrations register themselves in _migrations', () => {
    const files = readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.sql'))
      .sort();
    for (const file of files) {
      expect(sql(file), `${file} missing self-registration`).toContain(
        `INSERT INTO _migrations (filename) VALUES ('${file}')`
      );
    }
  });

  it('all migrations are wrapped in a transaction', () => {
    const files = readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.sql'))
      .sort();
    for (const file of files) {
      const content = sql(file);
      expect(content, `${file} missing BEGIN`).toMatch(/^\s*BEGIN\s*;/m);
      expect(content, `${file} missing COMMIT`).toMatch(/COMMIT\s*;?\s*$/m);
    }
  });
});

// ── 0002 extensions ───────────────────────────────────────────────────────────

describe('0002_create_extensions', () => {
  const content = sql('0002_create_extensions.sql');
  it('adds pgcrypto', () => expect(content).toContain('pgcrypto'));
  it('adds citext',   () => expect(content).toContain('citext'));
  it('uses IF NOT EXISTS', () => expect(content).toContain('IF NOT EXISTS'));
});

// ── 0003 tenancy schema ───────────────────────────────────────────────────────

describe('0003_create_tenancy_schema', () => {
  const content = sql('0003_create_tenancy_schema.sql');
  const norm    = sqlNorm('0003_create_tenancy_schema.sql');

  const tables = [
    'tenancy.tenants', 'tenancy.workspaces', 'tenancy.roles',
    'tenancy.permissions', 'tenancy.role_permissions',
    'tenancy.memberships', 'tenancy.membership_roles', 'tenancy.invitations',
  ];

  it.each(tables)('creates table %s', (t) => {
    expect(content).toMatch(new RegExp(`CREATE TABLE ${t}\\b`));
  });

  it('tenants slug is citext unique', () => {
    expect(content).toContain('slug             citext      NOT NULL UNIQUE');
  });

  it('tenant status is constrained', () => {
    expect(content).toContain("CHECK (status IN ('trial','active','suspended','closed'))");
  });

  it('workspace slug is unique per tenant', () => {
    expect(content).toContain('CONSTRAINT workspaces_tenant_slug_unique UNIQUE (tenant_id, slug)');
  });

  it('self-parenting not possible (memberships user_workspace unique)', () => {
    expect(content).toContain('CONSTRAINT memberships_user_workspace_unique UNIQUE (user_id, workspace_id)');
  });

  it('invitation token is stored as hash only', () => {
    expect(content).toContain('invitation_token_hash');
    expect(content).not.toContain('invitation_token text');
  });

  it('role scope is constrained', () => {
    expect(content).toContain("CHECK (scope IN ('platform','tenant','workspace','business'))");
  });
});

// ── 0004 identity schema ──────────────────────────────────────────────────────

describe('0004_create_identity_schema', () => {
  const content = sql('0004_create_identity_schema.sql');

  const tables = [
    'identity.users', 'identity.user_profiles', 'identity.service_accounts',
    'identity.api_key_references', 'identity.sessions',
  ];

  it.each(tables)('creates table %s', (t) => {
    expect(content).toMatch(new RegExp(`CREATE TABLE ${t}\\b`));
  });

  it('password_hash column not named password or plaintext', () => {
    expect(content).not.toContain('password text');
    expect(content).not.toContain('password_plain');
    expect(content).toContain('password_hash');
  });

  it('session_token stored as hash only', () => {
    expect(content).toContain('session_token_hash');
    expect(content).not.toContain('session_token text');
  });

  it('api key hash stored; raw key never stored', () => {
    expect(content).toContain('key_hash');
    expect(content).not.toContain('key_raw');
  });

  it('user status is constrained', () => {
    expect(content).toContain("CHECK (status IN ('pending','active','suspended','disabled','deleted'))");
  });

  it('back-fills FK from memberships to identity.users', () => {
    expect(content).toContain('ADD CONSTRAINT memberships_user_fk');
    expect(content).toContain('REFERENCES identity.users(id)');
  });
});

// ── 0005 platform schema ──────────────────────────────────────────────────────

describe('0005_create_platform_schema', () => {
  const content = sql('0005_create_platform_schema.sql');

  const tables = [
    'platform.businesses', 'platform.organization_units', 'platform.departments',
    'platform.locations', 'platform.system_settings', 'platform.feature_flags',
  ];

  it.each(tables)('creates table %s', (t) => {
    expect(content).toMatch(new RegExp(`CREATE TABLE ${t}\\b`));
  });

  it('business code is unique per tenant', () => {
    expect(content).toContain('CONSTRAINT businesses_code_tenant_unique UNIQUE (tenant_id, business_code)');
  });

  it('business status is constrained', () => {
    expect(content).toContain("CHECK (status IN ('draft','active','suspended','closed','archived'))");
  });

  it('version must be > 0', () => {
    expect(content).toContain('CHECK (version > 0)');
  });

  it('org unit type is constrained', () => {
    expect(content).toContain("CHECK (unit_type IN ('company','division','branch','department','team','location'))");
  });

  it('org unit self-parenting is blocked', () => {
    expect(content).toContain('CONSTRAINT org_units_no_self_parent CHECK (id <> parent_unit_id)');
  });
});

// ── 0006 audit schema ─────────────────────────────────────────────────────────

describe('0006_create_audit_schema', () => {
  const content = sql('0006_create_audit_schema.sql');

  it('creates audit.audit_events',    () => expect(content).toMatch(/CREATE TABLE audit\.audit_events\b/));
  it('creates audit.entity_versions', () => expect(content).toMatch(/CREATE TABLE audit\.entity_versions\b/));
  it('creates audit.access_events',   () => expect(content).toMatch(/CREATE TABLE audit\.access_events\b/));

  it('audit_events actor_type is constrained', () => {
    expect(content).toContain("CHECK (\n    actor_type IN ('user','service_account','system','integration')\n  )");
  });

  it('entity_versions has unique entity+version constraint', () => {
    expect(content).toContain('CONSTRAINT entity_versions_unique UNIQUE (entity_type, entity_id, entity_version)');
  });

  it('access_events type is constrained', () => {
    expect(content).toContain("'login','logout','failed_auth','permission_denied'");
  });
});

// ── 0007 events schema ────────────────────────────────────────────────────────

describe('0007_create_events_schema', () => {
  const content = sql('0007_create_events_schema.sql');

  const tables = [
    'events.outbox_events', 'events.inbox_events', 'events.dead_letter_events',
    'events.event_subscriptions', 'events.event_delivery_attempts',
  ];

  it.each(tables)('creates table %s', (t) => {
    expect(content).toMatch(new RegExp(`CREATE TABLE ${t}\\b`));
  });

  it('inbox events have idempotency constraint', () => {
    expect(content).toContain('CONSTRAINT inbox_events_idempotency UNIQUE (event_id, consumer_name)');
  });

  it('event delivery attempts have unique attempt number', () => {
    expect(content).toContain('CONSTRAINT event_delivery_attempts_unique UNIQUE (outbox_event_id, attempt_number)');
  });

  it('outbox status is constrained', () => {
    expect(content).toContain("CHECK (\n    status IN ('pending','processing','published','failed','dead_lettered')\n  )");
  });
});

// ── 0008 files schema ─────────────────────────────────────────────────────────

describe('0008_create_files_schema', () => {
  const content = sql('0008_create_files_schema.sql');

  it('creates files.file_objects',       () => expect(content).toMatch(/CREATE TABLE files\.file_objects\b/));
  it('creates files.file_versions',      () => expect(content).toMatch(/CREATE TABLE files\.file_versions\b/));
  it('creates files.file_links',         () => expect(content).toMatch(/CREATE TABLE files\.file_links\b/));
  it('creates files.file_access_events', () => expect(content).toMatch(/CREATE TABLE files\.file_access_events\b/));

  it('no binary/bytea columns for file content', () => {
    expect(content).not.toContain('bytea');
    expect(content).not.toContain('file_content');
    expect(content).not.toContain('file_data');
  });

  it('sha256_hash stored for integrity', () => {
    expect(content).toContain('sha256_hash');
  });

  it('file version uniqueness enforced', () => {
    expect(content).toContain('CONSTRAINT file_versions_unique UNIQUE (file_object_id, version)');
  });

  it('back-fills user_profiles avatar FK to files.file_objects', () => {
    expect(content).toContain('ADD CONSTRAINT user_profiles_avatar_fk');
  });
});

// ── 0009 canonical entities ───────────────────────────────────────────────────

describe('0009_create_canonical_entities', () => {
  const content = sql('0009_create_canonical_entities.sql');

  const tables = [
    'platform.customers', 'platform.suppliers', 'platform.employees',
    'platform.products', 'platform.services', 'platform.orders',
    'platform.invoices', 'platform.payments', 'platform.inventory_items',
    'platform.warehouses', 'platform.assets', 'platform.operational_events',
    'platform.metrics', 'platform.simulations', 'platform.decisions',
    'platform.approved_actions', 'platform.outcomes', 'platform.learning_items',
  ];

  it.each(tables)('creates table %s', (t) => {
    expect(content).toMatch(new RegExp(`CREATE TABLE ${t}\\b`));
  });

  it('decisions confidence is constrained between 0 and 1', () => {
    expect(content).toContain('CHECK (confidence >= 0 AND confidence <= 1)');
  });

  it('learning_items confidence and reliability are constrained', () => {
    expect(content).toContain('CONSTRAINT learning_items_confidence_check');
    expect(content).toContain('CONSTRAINT learning_items_reliability_check');
  });

  it('orders use operational status values from CLAUDE.md §10', () => {
    expect(content).toContain("'planned','authorized','executed','completed','failed','reversed'");
  });

  it('simulations use operational status values', () => {
    expect(content).toContain('CONSTRAINT simulations_status_check');
  });

  it('no layer-specific schema names used', () => {
    expect(content).not.toContain('data_acquisition.');
    expect(content).not.toContain('business_operations.');
    expect(content).not.toContain('decision_intelligence.');
  });
});

// ── 0010 indexes ──────────────────────────────────────────────────────────────

describe('0010_create_indexes', () => {
  const content = sql('0010_create_indexes.sql');

  it('covers tenant_id scoping for businesses', () => {
    expect(content).toContain('ON platform.businesses (tenant_id, workspace_id)');
  });

  it('covers event outbox pending status', () => {
    expect(content).toContain("WHERE status IN ('pending','failed')");
  });

  it('covers soft-deletion filters', () => {
    expect(content).toContain('WHERE deleted_at IS NULL');
  });

  it('covers correlation_id on businesses', () => {
    expect(content).toContain('ON platform.businesses (correlation_id)');
  });

  it('covers tenant+event_type on outbox', () => {
    expect(content).toContain('ON events.outbox_events (tenant_id, event_type)');
  });
});

// ── 0011 RLS ──────────────────────────────────────────────────────────────────

describe('0011_create_rls_policies', () => {
  const content = sql('0011_create_rls_policies.sql');

  const rlsTables = [
    'tenancy.tenants', 'tenancy.workspaces', 'tenancy.memberships',
    'platform.businesses', 'platform.customers', 'platform.orders',
    'audit.audit_events', 'events.outbox_events', 'files.file_objects',
  ];

  it.each(rlsTables)('enables RLS on %s', (t) => {
    expect(sqlNorm('0011_create_rls_policies.sql')).toContain(
      `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`
    );
  });

  it('tenant isolation policy uses current_setting', () => {
    expect(content).toContain("current_setting('app.tenant_id', true)::uuid");
  });

  it('workspace isolation enforced on memberships', () => {
    expect(content).toContain("current_setting('app.workspace_id', true)::uuid");
  });

  it('system roles (null tenant) remain visible', () => {
    expect(content).toContain('tenant_id IS NULL');
  });

  it('identity.users NOT added to RLS (global table)', () => {
    expect(content).not.toContain('ALTER TABLE identity.users ENABLE ROW LEVEL SECURITY');
  });
});

// ── 0012 triggers ─────────────────────────────────────────────────────────────

describe('0012_create_updated_at_triggers', () => {
  const content = sql('0012_create_updated_at_triggers.sql');

  const triggerTables = [
    ['tenancy.tenants',          'trg_tenancy_tenants_updated_at'],
    ['tenancy.workspaces',       'trg_tenancy_workspaces_updated_at'],
    ['identity.users',           'trg_identity_users_updated_at'],
    ['platform.businesses',      'trg_platform_businesses_updated_at'],
    ['platform.orders',          'trg_platform_orders_updated_at'],
    ['platform.decisions',       'trg_platform_decisions_updated_at'],
    ['files.file_objects',       'trg_files_file_objects_updated_at'],
    ['events.event_subscriptions','trg_events_subscriptions_updated_at'],
  ];

  it.each(triggerTables)('trigger %s exists on %s', (table, trigger) => {
    expect(content).toContain(trigger);
    expect(content).toContain(`ON ${table}`);
  });

  it('reuses existing set_updated_at() function', () => {
    expect(content).toContain('EXECUTE FUNCTION set_updated_at()');
    expect(content).not.toContain('CREATE OR REPLACE FUNCTION set_updated_at');
  });

  it('does NOT add triggers to append-only tables', () => {
    expect(content).not.toContain('ON audit.audit_events');
    expect(content).not.toContain('ON audit.access_events');
    expect(content).not.toContain('ON events.event_delivery_attempts');
    expect(content).not.toContain('ON files.file_access_events');
  });
});
