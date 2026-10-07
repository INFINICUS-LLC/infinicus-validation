/**
 * Live round-trip integration tests for all Stage 2B DA repositories.
 * Requires: DATABASE_URL and ADMIN_DATABASE_URL environment variables.
 * Skip without env vars so the standard `pnpm test` (structural) stays green.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';

import {
  setupIntegration,
  teardownIntegration,
  ctx1,
  ctx2,
  T1,
  WS1,
  UID,
  uniqueCode,
} from './helpers/integration.js';

import { DataSourceRepository, NotFoundError } from '../src/repositories/da/DataSourceRepository.js';
import { ConnectorRepository }              from '../src/repositories/da/ConnectorRepository.js';
import { CollectionRunRepository }          from '../src/repositories/da/CollectionRunRepository.js';
import { ValidationResultRepository }       from '../src/repositories/da/ValidationResultRepository.js';
import { DataQualityScoreRepository }       from '../src/repositories/da/DataQualityScoreRepository.js';
import { ProvenanceRepository, MAX_LINEAGE_DEPTH } from '../src/repositories/da/ProvenanceRepository.js';
import { PublicationPackageRepository }     from '../src/repositories/da/PublicationPackageRepository.js';
import { ManualSubmissionRepository, MANUAL_SUBMISSION_STATUSES } from '../src/repositories/da/ManualSubmissionRepository.js';
import type { ManualSubmissionStatus } from '../src/repositories/da/ManualSubmissionRepository.js';
import { UnsupportedConnectorError, ValidationError, InvalidStateTransitionError, ProvenanceError } from '../src/repositories/da/errors.js';
import { withTenantTransaction }            from '../src/client.js';

const RUN = !!process.env.DATABASE_URL;

describe.runIf(RUN)('Integration: DataSourceRepository', () => {
  const repo = new DataSourceRepository();
  let sourceId: string;
  const correlationId = '00000000-aaaa-bbbb-cccc-000000000001';

  beforeAll(setupIntegration);
  afterAll(teardownIntegration);

  it('creates a data source and returns mapped fields', async () => {
    const src = await repo.create(ctx1, {
      name:           'CRM Export',
      sourceCode:     uniqueCode('crm'),
      sourceType:     'api',
      sensitivityLevel: 'internal',
      correlationId,
    });
    sourceId = src.id;

    expect(src.id).toBeTruthy();
    expect(src.tenantId).toBe(T1);
    expect(src.workspaceId).toBe(WS1);
    expect(src.name).toBe('CRM Export');
    expect(src.sourceType).toBe('api');
    expect(src.sensitivityLevel).toBe('internal');
    expect(src.status).toBe('draft');
    expect(src.version).toBe(1);
    expect(src.correlationId).toBe(correlationId);
  });

  it('finds the created source by id', async () => {
    const found = await repo.findById(ctx1, sourceId);
    expect(found.id).toBe(sourceId);
    expect(found.name).toBe('CRM Export');
  });

  it('listActive returns empty when status is draft', async () => {
    const list = await repo.listActive(ctx1);
    const ids = list.map((s) => s.id);
    expect(ids).not.toContain(sourceId);
  });

  it('updateStatus transitions status and bumps version', async () => {
    const updated = await repo.updateStatus(ctx1, sourceId, 'active');
    expect(updated.status).toBe('active');
    expect(updated.version).toBe(2);
  });

  it('listActive returns source after it is activated', async () => {
    const list = await repo.listActive(ctx1);
    expect(list.map((s) => s.id)).toContain(sourceId);
  });

  it('softDelete marks deleted_at and status=retired', async () => {
    await repo.softDelete(ctx1, sourceId);
    const found = await repo.findById(ctx1, sourceId);
    expect(found.deletedAt).not.toBeNull();
    expect(found.status).toBe('retired');
  });

  it('listActive excludes soft-deleted source', async () => {
    const list = await repo.listActive(ctx1);
    expect(list.map((s) => s.id)).not.toContain(sourceId);
  });

  it('throws NotFoundError for unknown id', async () => {
    await expect(
      repo.findById(ctx1, '00000000-0000-0000-0000-deadbeef0001')
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('tenant isolation: ctx2 cannot see ctx1 source', async () => {
    await expect(
      repo.findById(ctx2, sourceId)
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('workspace isolation: wrong workspace cannot see source', async () => {
    const wrongCtx = { ...ctx1, workspaceId: '00000000-0000-0000-dead-beef00000001' };
    await expect(
      repo.findById(wrongCtx, sourceId)
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe.runIf(RUN)('Integration: ConnectorRepository', () => {
  const srcRepo  = new DataSourceRepository();
  const connRepo = new ConnectorRepository();
  let sourceId: string;
  let connectorId: string;
  let build31SourceId: string;

  // Fixed, guaranteed-absent ids. Reaching the database with these would
  // raise a foreign-key or not-found error, so a test that instead sees the
  // expected controlled error proves validation ran BEFORE any SQL.
  const ABSENT_SOURCE_ID    = '00000000-0000-0000-0000-deadbeef0031';
  const ABSENT_CONNECTOR_ID = '00000000-0000-0000-0000-deadbeef0032';

  beforeAll(async () => {
    await setupIntegration();
    const src = await srcRepo.create(ctx1, {
      name:             'BUILD-31 Connector Source',
      sourceCode:       uniqueCode('build31'),
      sourceType:       'api',
      sensitivityLevel: 'public',
    });
    build31SourceId = src.id;
  });
  afterAll(teardownIntegration);

  it('creates connector linked to a data source', async () => {
    const src = await srcRepo.create(ctx1, {
      name: 'REST Source', sourceCode: uniqueCode('rest'), sourceType: 'api', sensitivityLevel: 'public',
    });
    sourceId = src.id;

    const conn = await connRepo.create(ctx1, {
      dataSourceId:   sourceId,
      name:           'REST Connector',
      connectorType:  'rest_api',
      connectorVersion: '2.0',
      correlationId:  '00000000-aaaa-0000-0000-000000000002',
    });
    connectorId = conn.id;

    expect(conn.id).toBeTruthy();
    expect(conn.dataSourceId).toBe(sourceId);
    expect(conn.connectorType).toBe('rest_api');
    expect(conn.connectorVersion).toBe('2.0');
    expect(conn.healthStatus).toBe('unknown');
  });

  it('findById returns the connector', async () => {
    const found = await connRepo.findById(ctx1, connectorId);
    expect(found.name).toBe('REST Connector');
  });

  it('listByDataSource returns connector', async () => {
    const list = await connRepo.listByDataSource(ctx1, sourceId);
    expect(list.map((c) => c.id)).toContain(connectorId);
  });

  it('updateHealth sets healthStatus and lastHealthCheckAt', async () => {
    const updated = await connRepo.updateHealth(ctx1, connectorId, 'healthy');
    expect(updated.healthStatus).toBe('healthy');
    expect(updated.lastHealthCheckAt).not.toBeNull();
    expect(updated.version).toBe(2);
  });

  it('throws NotFoundError for unknown connector', async () => {
    await expect(
      connRepo.findById(ctx1, '00000000-0000-0000-0000-deadbeef0002')
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('tenant isolation: ctx2 cannot see ctx1 connector', async () => {
    await expect(
      connRepo.findById(ctx2, connectorId)
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('accepts the manual_json connector type', async () => {
    const conn = await connRepo.create(ctx1, {
      dataSourceId:  build31SourceId,
      name:          'Manual JSON intake',
      connectorType: 'manual_json',
    });
    expect(conn.connectorType).toBe('manual_json');
  });

  it('accepts every other supported connector type', async () => {
    const types = [
      'rest_api', 'graphql', 'webhook', 'postgres', 'mysql', 'mssql',
      'sqlite', 'sftp', 'object_storage', 'file_upload', 'event_stream', 'custom',
    ];
    for (const connectorType of types) {
      const conn = await connRepo.create(ctx1, {
        dataSourceId: build31SourceId,
        name:         `probe-${connectorType}`,
        connectorType,
      });
      expect(conn.connectorType).toBe(connectorType);
    }
  });

  it('throws UnsupportedConnectorError for an unsupported connector type', async () => {
    await expect(
      connRepo.create(ctx1, {
        dataSourceId:  ABSENT_SOURCE_ID,
        name:          'bogus',
        connectorType: 'not_a_real_connector',
      })
    ).rejects.toBeInstanceOf(UnsupportedConnectorError);
  });

  it('exposes the offending type on UnsupportedConnectorError', async () => {
    await expect(
      connRepo.create(ctx1, {
        dataSourceId:  ABSENT_SOURCE_ID,
        name:          'bogus',
        connectorType: 'not_a_real_connector',
      })
    ).rejects.toMatchObject({ connectorType: 'not_a_real_connector' });
  });

  it('throws ValidationError for an invalid create status', async () => {
    await expect(
      connRepo.create(ctx1, {
        dataSourceId:  ABSENT_SOURCE_ID,
        name:          'bad-status',
        connectorType: 'rest_api',
        status:        'not_a_status',
      })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('throws ValidationError for an invalid status before touching the database', async () => {
    await expect(
      connRepo.updateStatus(ctx1, ABSENT_CONNECTOR_ID, 'not_a_status' as never)
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('throws ValidationError for an invalid health status before touching the database', async () => {
    await expect(
      connRepo.updateHealth(ctx1, ABSENT_CONNECTOR_ID, 'not_a_health_status' as never)
    ).rejects.toBeInstanceOf(ValidationError);
  });

  describe('webhook token', () => {
    let webhookConnectorId: string;

    beforeAll(async () => {
      const conn = await connRepo.create(ctx1, {
        dataSourceId: build31SourceId, name: 'Webhook Connector', connectorType: 'webhook',
      });
      webhookConnectorId = conn.id;
    });

    it('generateWebhookToken returns a raw prefix.secret token and persists only its hash', async () => {
      const rawToken = await connRepo.generateWebhookToken(ctx1, webhookConnectorId);
      expect(rawToken).toMatch(/^[0-9a-f]{12}\.[0-9a-f]{64}$/);

      const connector = await connRepo.findById(ctx1, webhookConnectorId);
      expect(connector.webhookTokenPrefix).toBe(rawToken.split('.')[0]);
      // The stored row never carries the secret itself in plain form under
      // any exposed field — webhookTokenHash is intentionally absent from
      // the public Connector shape (see rowToConnector).
      expect(JSON.stringify(connector)).not.toContain(rawToken.split('.')[1]);
    });

    it('findConnectorForWebhook resolves the connector across tenants without any TenantContext (RLS bypass via SECURITY DEFINER)', async () => {
      const rawToken = await connRepo.generateWebhookToken(ctx1, webhookConnectorId);
      const [prefix] = rawToken.split('.');

      const lookup = await connRepo.findConnectorForWebhook(prefix);
      expect(lookup).not.toBeNull();
      expect(lookup!.connectorId).toBe(webhookConnectorId);
      expect(lookup!.tenantId).toBe(ctx1.tenantId);
      expect(lookup!.workspaceId).toBe(ctx1.workspaceId);
      expect(lookup!.dataSourceId).toBe(build31SourceId);
      expect(lookup!.connectorStatus).toBe('draft');
    });

    it('findConnectorForWebhook returns null for an unknown prefix', async () => {
      const lookup = await connRepo.findConnectorForWebhook('does-not-exist');
      expect(lookup).toBeNull();
    });

    it('regenerating the token invalidates the previous one', async () => {
      const first = await connRepo.generateWebhookToken(ctx1, webhookConnectorId);
      const second = await connRepo.generateWebhookToken(ctx1, webhookConnectorId);
      expect(second).not.toBe(first);

      const [firstPrefix] = first.split('.');
      const [secondPrefix] = second.split('.');
      expect(await connRepo.findConnectorForWebhook(firstPrefix)).toBeNull();
      expect(await connRepo.findConnectorForWebhook(secondPrefix)).not.toBeNull();
    });
  });
});

describe.runIf(RUN)('Schema: connectors_type_check', () => {
  const srcRepo = new DataSourceRepository();
  let sourceId: string;

  beforeAll(async () => {
    await setupIntegration();
    const src = await srcRepo.create(ctx1, {
      name:             'Constraint Probe Source',
      sourceCode:       uniqueCode('constraint'),
      sourceType:       'api',
      sensitivityLevel: 'public',
    });
    sourceId = src.id;
  });
  afterAll(teardownIntegration);

  it('accepts manual_json on a direct INSERT', async () => {
    await withTenantTransaction(ctx1, async (client) => {
      const res = await client.query(
        `INSERT INTO data_acquisition.connectors
           (tenant_id, workspace_id, data_source_id, name, connector_type)
         VALUES ($1,$2,$3,$4,$5) RETURNING connector_type`,
        [ctx1.tenantId, ctx1.workspaceId, sourceId, 'direct-manual', 'manual_json']
      );
      expect(res.rows[0].connector_type).toBe('manual_json');
    });
  });

  it('accepts all twelve original values on a direct INSERT', async () => {
    const types = [
      'rest_api', 'graphql', 'webhook', 'postgres', 'mysql', 'mssql',
      'sqlite', 'sftp', 'object_storage', 'file_upload', 'event_stream', 'custom',
    ];
    for (const type of types) {
      await withTenantTransaction(ctx1, async (client) => {
        const res = await client.query(
          `INSERT INTO data_acquisition.connectors
             (tenant_id, workspace_id, data_source_id, name, connector_type)
           VALUES ($1,$2,$3,$4,$5) RETURNING connector_type`,
          [ctx1.tenantId, ctx1.workspaceId, sourceId, `direct-${type}`, type]
        );
        expect(res.rows[0].connector_type).toBe(type);
      });
    }
  });

  // Defence in depth: the repository now rejects this first, but the
  // database must still reject it for any writer that bypasses the
  // repository.
  it('rejects an unknown connector type on a direct INSERT', async () => {
    await expect(
      withTenantTransaction(ctx1, async (client) => {
        await client.query(
          `INSERT INTO data_acquisition.connectors
             (tenant_id, workspace_id, data_source_id, name, connector_type)
           VALUES ($1,$2,$3,$4,$5)`,
          [ctx1.tenantId, ctx1.workspaceId, sourceId, 'direct-bogus', 'not_a_real_connector']
        );
      })
    ).rejects.toThrow(/connectors_type_check/);
  });
});

describe.runIf(RUN)('Schema: find_connector_for_webhook() hardening', () => {
  const FN = "'data_acquisition.find_connector_for_webhook(text)'::regprocedure";

  beforeAll(setupIntegration);
  afterAll(teardownIntegration);

  it('is SECURITY DEFINER with a pinned search_path (pg_catalog, pg_temp)', async () => {
    await withTenantTransaction(ctx1, async (client) => {
      const res = await client.query(
        `SELECT prosecdef, proconfig FROM pg_proc WHERE oid = ${FN}`
      );
      expect(res.rows[0].prosecdef).toBe(true);
      expect(res.rows[0].proconfig).toContain('search_path=pg_catalog, pg_temp');
    });
  });

  it('is not executable by PUBLIC', async () => {
    await withTenantTransaction(ctx1, async (client) => {
      const res = await client.query(
        `SELECT count(*)::int AS n
           FROM pg_proc p, aclexplode(p.proacl) a
          WHERE p.oid = ${FN} AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'`
      );
      expect(res.rows[0].n).toBe(0);
    });
  });

  it('is executable by the application role (granted by grant-app-role.sh, not by the migration)', async () => {
    await withTenantTransaction(ctx1, async (client) => {
      const res = await client.query(
        `SELECT has_function_privilege(current_user, ${FN}, 'EXECUTE') AS ok`
      );
      expect(res.rows[0].ok).toBe(true);
    });
  });
});

describe.runIf(RUN)('Integration: CollectionRunRepository', () => {
  const srcRepo = new DataSourceRepository();
  const runRepo = new CollectionRunRepository();

  const ABSENT_RUN_ID = '00000000-0000-0000-0000-deadbeef0003';

  // BYPASSRLS pool, required only to seed and remove the platform.businesses
  // fixture that collection_runs.business_id references. Mirrors the
  // convention used by the bi/adi/aba/bo/cl/dt integration suites. Constructed
  // inside beforeAll so it never exists when this block is skipped.
  let adminPool: Pool | null = null;

  let businessId: string;
  let sourceId: string;
  let otherSourceId: string;

  beforeAll(async () => {
    await setupIntegration();

    // ADMIN_DATABASE_URL only — no DATABASE_URL fallback, so a missing admin
    // URL fails loudly instead of silently degrading to the RLS-enforced role.
    adminPool = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });

    // Unique per execution: teardownIntegration does not clean
    // platform.businesses, and businesses_code_tenant_unique means a fixed
    // business_code would collide on re-run. Removed in afterAll below.
    const biz = await adminPool.query<{ id: string }>(
      `INSERT INTO platform.businesses
         (tenant_id, workspace_id, legal_name, business_code, status)
       VALUES ($1,$2,'DA Run Test Biz',$3,'active')
       RETURNING id`,
      [T1, WS1, uniqueCode('da-run-biz')]
    );
    businessId = biz.rows[0].id;

    const src = await srcRepo.create(ctx1, {
      name: 'API Src', sourceCode: uniqueCode('api-src'), sourceType: 'api', sensitivityLevel: 'internal',
    });
    sourceId = src.id;

    // A second source used only by the pagination test, so its run count is
    // unaffected by anything the other tests create.
    const other = await srcRepo.create(ctx1, {
      name: 'Paging Src', sourceCode: uniqueCode('paging-src'), sourceType: 'api', sensitivityLevel: 'internal',
    });
    otherSourceId = other.id;
  });

  afterAll(async () => {
    try {
      try {
        if (adminPool && businessId) {
          // collection_runs.business_id is ON DELETE SET NULL, so this is safe
          // regardless of whether runs still reference it.
          await adminPool.query('DELETE FROM platform.businesses WHERE id = $1', [businessId]);
        }
      } finally {
        if (adminPool) await adminPool.end();
        adminPool = null;
      }
    } finally {
      await teardownIntegration();
    }
  });

  // ── fixtures: every lifecycle test builds its own run through these ────────

  async function newRun(opts: { dataSourceId?: string; businessId?: string } = {}) {
    return runRepo.create(ctx1, {
      dataSourceId:   opts.dataSourceId ?? sourceId,
      businessId:     opts.businessId,
      collectionType: 'api',
    });
  }

  /**
   * A `scheduled` run, created by direct INSERT because create() enters at
   * `planned` only. 'scheduled' is permitted by collection_runs_state_check in
   * migration 0014, so no constraint is bypassed — this is what a scheduler
   * would write.
   */
  async function newScheduledRun(): Promise<string> {
    return withTenantTransaction(ctx1, async (client) => {
      const res = await client.query<{ id: string }>(
        `INSERT INTO data_acquisition.collection_runs
           (tenant_id, workspace_id, data_source_id, collection_type, state)
         VALUES ($1,$2,$3,'api','scheduled')
         RETURNING id`,
        [ctx1.tenantId, ctx1.workspaceId, sourceId]
      );
      return res.rows[0].id;
    });
  }

  async function newCollecting() {
    const run = await newRun();
    return runRepo.markStarted(ctx1, run.id);
  }

  async function newCollected() {
    const run = await newCollecting();
    // accepted + rejected <= received, per collection_runs_counts_coherent.
    return runRepo.markCompleted(ctx1, run.id, {
      recordsReceived: 10,
      recordsAccepted: 9,
      recordsRejected: 1,
      bytesReceived:   1024,
    });
  }

  async function newValidated() {
    const run = await newCollected();
    return runRepo.markValidated(ctx1, run.id);
  }

  /**
   * Outbox rows for one run, read through adminPool.
   *
   * app_test_user has no USAGE on the events schema (PostgreSQL 42501), so the
   * app-role connection cannot inspect the outbox. The BYPASSRLS admin pool
   * already created for this block is used instead. Because BYPASSRLS means
   * outbox_events_isolation is not enforcing tenancy on this connection,
   * tenant_id and workspace_id are asserted explicitly in the predicate rather
   * than relied upon.
   */
  async function eventsFor(runId: string, eventType: string) {
    if (!adminPool) {
      throw new Error('eventsFor requires adminPool; beforeAll did not run');
    }
    const res = await adminPool.query<Record<string, unknown>>(
      `SELECT event_type, event_version, aggregate_type, aggregate_id,
              payload, status, correlation_id
         FROM events.outbox_events
        WHERE tenant_id    = $1
          AND workspace_id = $2
          AND aggregate_id = $3
          AND event_type   = $4
        ORDER BY created_at`,
      [ctx1.tenantId, ctx1.workspaceId, runId, eventType]
    );
    return res.rows;
  }

  // ── preserved behaviour ───────────────────────────────────────────────────

  it('creates a collection run in planned state', async () => {
    const run = await runRepo.create(ctx1, {
      dataSourceId:   sourceId,
      collectionType: 'api',
      correlationId:  '00000000-aaaa-0000-0000-000000000003',
    });
    expect(run.state).toBe('planned');
    expect(run.dataSourceId).toBe(sourceId);
    expect(run.recordsReceived).toBe(0);
    expect(run.correlationId).toBe('00000000-aaaa-0000-0000-000000000003');
  });

  it('findById retrieves the run', async () => {
    const run = await newRun();
    const found = await runRepo.findById(ctx1, run.id);
    expect(found.id).toBe(run.id);
    expect(found.state).toBe('planned');
  });

  it('correlation ID is preserved on the run', async () => {
    const run = await runRepo.create(ctx1, {
      dataSourceId:   sourceId,
      collectionType: 'api',
      correlationId:  '00000000-aaaa-0000-0000-00000000030a',
    });
    const found = await runRepo.findById(ctx1, run.id);
    expect(found.correlationId).toBe('00000000-aaaa-0000-0000-00000000030a');
  });

  // 17
  it('throws NotFoundError for unknown run', async () => {
    await expect(
      runRepo.findById(ctx1, ABSENT_RUN_ID)
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  // 18
  it('tenant isolation: ctx2 cannot see ctx1 run', async () => {
    const run = await newRun();
    await expect(
      runRepo.findById(ctx2, run.id)
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  // ── frozen edges ──────────────────────────────────────────────────────────

  // 1
  it('planned -> collecting', async () => {
    const run = await newRun();
    const started = await runRepo.markStarted(ctx1, run.id);
    expect(started.state).toBe('collecting');
    expect(started.startedAt).not.toBeNull();
  });

  // 2
  it('scheduled -> collecting', async () => {
    const scheduledId = await newScheduledRun();
    const before = await runRepo.findById(ctx1, scheduledId);
    expect(before.state).toBe('scheduled');

    const started = await runRepo.markStarted(ctx1, scheduledId);
    expect(started.state).toBe('collecting');
    expect(started.startedAt).not.toBeNull();
  });

  // 3
  it('collecting -> collected with counts persisted', async () => {
    const run = await newCollecting();
    const completed = await runRepo.markCompleted(ctx1, run.id, {
      recordsReceived: 1000,
      recordsAccepted: 980,
      recordsRejected: 20,
      bytesReceived:   512000,
    });
    expect(completed.state).toBe('collected');
    expect(completed.recordsReceived).toBe(1000);
    expect(completed.recordsAccepted).toBe(980);
    expect(completed.recordsRejected).toBe(20);
    expect(completed.bytesReceived).toBe(512000);
    expect(completed.completedAt).not.toBeNull();
  });

  // 4 — replaces the old planned -> markFailed test; assertions unchanged.
  it('collecting -> failed', async () => {
    const run = await newCollecting();
    const failed = await runRepo.markFailed(ctx1, run.id, 'TIMEOUT', 'connection timed out');
    expect(failed.state).toBe('failed');
    expect(failed.errorCode).toBe('TIMEOUT');
    expect(failed.errorMessage).toBe('connection timed out');
    expect(failed.completedAt).not.toBeNull();
  });

  // 5
  it('collecting -> cancelled', async () => {
    const run = await newCollecting();
    const cancelled = await runRepo.markCancelled(ctx1, run.id);
    expect(cancelled.state).toBe('cancelled');
    expect(cancelled.completedAt).not.toBeNull();
  });

  // 6
  it('collected -> validated', async () => {
    const run = await newCollected();
    const validated = await runRepo.markValidated(ctx1, run.id);
    expect(validated.state).toBe('validated');
  });

  // 7
  it('collected -> quarantined', async () => {
    const run = await newCollected();
    const quarantined = await runRepo.markQuarantined(ctx1, run.id);
    expect(quarantined.state).toBe('quarantined');
  });

  // 8
  it('validated -> published', async () => {
    const run = await newValidated();
    const published = await runRepo.markPublished(ctx1, run.id);
    expect(published.state).toBe('published');
  });

  // 9
  it('validated -> quarantined', async () => {
    const run = await newValidated();
    const quarantined = await runRepo.markQuarantined(ctx1, run.id);
    expect(quarantined.state).toBe('quarantined');
  });

  // 10
  it('quarantined -> validated', async () => {
    const run = await newCollected();
    const quarantined = await runRepo.markQuarantined(ctx1, run.id);
    expect(quarantined.state).toBe('quarantined');

    const revalidated = await runRepo.markValidated(ctx1, run.id);
    expect(revalidated.state).toBe('validated');
  });

  // ── invalid transitions ───────────────────────────────────────────────────

  // 11
  it('starting an already collecting run throws InvalidStateTransitionError', async () => {
    const run = await newCollecting();
    await expect(
      runRepo.markStarted(ctx1, run.id)
    ).rejects.toBeInstanceOf(InvalidStateTransitionError);
  });

  // 12
  it('completing the same run twice throws InvalidStateTransitionError', async () => {
    const run = await newCollected();
    await expect(
      runRepo.markCompleted(ctx1, run.id, {
        recordsReceived: 10,
        recordsAccepted: 9,
        recordsRejected: 1,
        bytesReceived:   1024,
      })
    ).rejects.toBeInstanceOf(InvalidStateTransitionError);
  });

  // 13
  it('completing a failed run throws InvalidStateTransitionError', async () => {
    const run = await newCollecting();
    await runRepo.markFailed(ctx1, run.id, 'TIMEOUT', 'gone');
    await expect(
      runRepo.markCompleted(ctx1, run.id, {
        recordsReceived: 10,
        recordsAccepted: 9,
        recordsRejected: 1,
        bytesReceived:   1024,
      })
    ).rejects.toBeInstanceOf(InvalidStateTransitionError);
  });

  // 14
  it('publishing an unvalidated run throws InvalidStateTransitionError', async () => {
    const run = await newCollected();
    await expect(
      runRepo.markPublished(ctx1, run.id)
    ).rejects.toBeInstanceOf(InvalidStateTransitionError);
  });

  // 15
  it('validating a cancelled run throws InvalidStateTransitionError', async () => {
    const run = await newCollecting();
    await runRepo.markCancelled(ctx1, run.id);
    await expect(
      runRepo.markValidated(ctx1, run.id)
    ).rejects.toBeInstanceOf(InvalidStateTransitionError);
  });

  // 16
  it('publishing an already published run throws InvalidStateTransitionError', async () => {
    const run = await newValidated();
    await runRepo.markPublished(ctx1, run.id);
    await expect(
      runRepo.markPublished(ctx1, run.id)
    ).rejects.toBeInstanceOf(InvalidStateTransitionError);
  });

  // ── non-lifecycle ─────────────────────────────────────────────────────────

  // 19
  it('listBySource returns only that source and respects pagination', async () => {
    await newRun({ dataSourceId: otherSourceId });
    await newRun({ dataSourceId: otherSourceId });
    await newRun({ dataSourceId: otherSourceId });

    const all = await runRepo.listBySource(ctx1, otherSourceId);
    expect(all).toHaveLength(3);
    expect(all.every((r) => r.dataSourceId === otherSourceId)).toBe(true);

    const firstPage = await runRepo.listBySource(ctx1, otherSourceId, { limit: 2 });
    expect(firstPage).toHaveLength(2);

    const secondPage = await runRepo.listBySource(ctx1, otherSourceId, { limit: 2, offset: 2 });
    expect(secondPage).toHaveLength(1);

    const overlap = firstPage.map((r) => r.id).filter((id) => secondPage.some((s) => s.id === id));
    expect(overlap).toHaveLength(0);
  });

  // 20
  it('listByBusiness returns only that business and respects pagination', async () => {
    await newRun({ businessId });
    await newRun({ businessId });

    const all = await runRepo.listByBusiness(ctx1, businessId);
    expect(all).toHaveLength(2);
    expect(all.every((r) => r.businessId === businessId)).toBe(true);

    const firstPage = await runRepo.listByBusiness(ctx1, businessId, { limit: 1 });
    expect(firstPage).toHaveLength(1);

    const secondPage = await runRepo.listByBusiness(ctx1, businessId, { limit: 1, offset: 1 });
    expect(secondPage).toHaveLength(1);
    expect(secondPage[0].id).not.toBe(firstPage[0].id);
  });

  // 21
  it('updateRequestMetadata persists the exact metadata', async () => {
    const run = await newRun();
    const metadata = { endpoint: '/v1/orders', method: 'GET', pageSize: 100 };
    const updated = await runRepo.updateRequestMetadata(ctx1, run.id, metadata);
    expect(updated.requestMetadata).toEqual(metadata);

    const reread = await runRepo.findById(ctx1, run.id);
    expect(reread.requestMetadata).toEqual(metadata);
    expect(reread.state).toBe('planned');
  });

  // 22
  it('updateCheckpoint persists the exact checkpoint', async () => {
    const run = await newRun();
    const checkpoint = { cursor: 'abc123', page: 7, lastSeenAt: '2026-01-01T00:00:00.000Z' };
    const updated = await runRepo.updateCheckpoint(ctx1, run.id, checkpoint);
    expect(updated.checkpoint).toEqual(checkpoint);

    const reread = await runRepo.findById(ctx1, run.id);
    expect(reread.checkpoint).toEqual(checkpoint);
    expect(reread.state).toBe('planned');
  });

  // 23
  it('incrementRetryAttempt increments by exactly one per explicit call', async () => {
    const run = await newRun();
    expect(run.attemptNumber).toBe(1);

    const second = await runRepo.incrementRetryAttempt(ctx1, run.id);
    expect(second.attemptNumber).toBe(2);

    const third = await runRepo.incrementRetryAttempt(ctx1, run.id);
    expect(third.attemptNumber).toBe(3);
  });

  it('updateRequestMetadata throws NotFoundError for an unknown run', async () => {
    await expect(
      runRepo.updateRequestMetadata(ctx1, ABSENT_RUN_ID, { a: 1 })
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('incrementRetryAttempt throws NotFoundError for an unknown run', async () => {
    await expect(
      runRepo.incrementRetryAttempt(ctx1, ABSENT_RUN_ID)
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  // ── outbox ────────────────────────────────────────────────────────────────

  // 24
  it('markStarted creates a da.collection.started outbox event', async () => {
    const run = await newRun();
    await runRepo.markStarted(ctx1, run.id);

    const rows = await eventsFor(run.id, 'da.collection.started');
    expect(rows).toHaveLength(1);
    expect(rows[0].aggregate_type).toBe('collection_run');
    expect(rows[0].aggregate_id).toBe(run.id);
    expect(rows[0].status).toBe('pending');
    expect(rows[0].correlation_id).toBe(run.correlationId);

    const payload = rows[0].payload as Record<string, unknown>;
    expect(payload.collectionRunId).toBe(run.id);
    expect(payload.sourceId).toBe(sourceId);
    expect(payload.collectionType).toBe('api');
  });

  // 25
  it('markCompleted creates a da.collection.completed outbox event', async () => {
    const run = await newCollecting();
    await runRepo.markCompleted(ctx1, run.id, {
      recordsReceived: 50,
      recordsAccepted: 45,
      recordsRejected: 5,
      bytesReceived:   2048,
    });

    const rows = await eventsFor(run.id, 'da.collection.completed');
    expect(rows).toHaveLength(1);
    expect(rows[0].aggregate_type).toBe('collection_run');
    expect(rows[0].aggregate_id).toBe(run.id);
    expect(rows[0].status).toBe('pending');

    const payload = rows[0].payload as Record<string, unknown>;
    expect(payload.collectionRunId).toBe(run.id);
    expect(payload.sourceId).toBe(sourceId);
    expect(payload.recordsReceived).toBe(50);
    expect(payload.recordsAccepted).toBe(45);
    expect(payload.recordsRejected).toBe(5);
  });

  // 26
  it('markFailed creates a da.collection.failed outbox event', async () => {
    const run = await newCollecting();
    await runRepo.markFailed(ctx1, run.id, 'UPSTREAM_5XX', 'origin returned 503');

    const rows = await eventsFor(run.id, 'da.collection.failed');
    expect(rows).toHaveLength(1);
    expect(rows[0].aggregate_type).toBe('collection_run');
    expect(rows[0].aggregate_id).toBe(run.id);
    expect(rows[0].status).toBe('pending');

    const payload = rows[0].payload as Record<string, unknown>;
    expect(payload.collectionRunId).toBe(run.id);
    expect(payload.sourceId).toBe(sourceId);
    expect(payload.errorCode).toBe('UPSTREAM_5XX');
  });

  /**
   * Narrow assertion only. A rejected guard fails BEFORE the emitter is
   * reached, so this does NOT demonstrate that an emitter failure rolls back a
   * successful domain mutation. That remains untested — see the Step 5 report.
   */
  it('a rejected transition does not create an additional collection event', async () => {
    const run = await newCollecting();
    const before = await eventsFor(run.id, 'da.collection.started');
    expect(before).toHaveLength(1);

    await expect(
      runRepo.markStarted(ctx1, run.id)
    ).rejects.toBeInstanceOf(InvalidStateTransitionError);

    const after = await eventsFor(run.id, 'da.collection.started');
    expect(after).toHaveLength(1);
  });
});

describe.runIf(RUN)('Integration: ValidationResultRepository', () => {
  const srcRepo = new DataSourceRepository();
  const runRepo = new CollectionRunRepository();
  const valRepo = new ValidationResultRepository();
  let runId: string;
  let resultId: string;

  beforeAll(setupIntegration);
  afterAll(teardownIntegration);

  it('creates a validation result with issues atomically', async () => {
    const src = await srcRepo.create(ctx1, {
      name: 'Val Src', sourceCode: uniqueCode('val-src'), sourceType: 'file', sensitivityLevel: 'internal',
    });
    const run = await runRepo.create(ctx1, { dataSourceId: src.id, collectionType: 'file' });
    runId = run.id;

    const { result, issues } = await valRepo.create(
      ctx1,
      {
        collectionRunId: runId,
        isValid:         false,
        errorCount:      2,
        warningCount:    1,
        correlationId:   '00000000-aaaa-0000-0000-000000000004',
      },
      [
        { ruleCode: 'REQUIRED_FIELD', severity: 'error',   issueType: 'missing_field', message: 'email missing' },
        { ruleCode: 'FORMAT_CHECK',   severity: 'error',   issueType: 'invalid_format', message: 'date format wrong' },
        { ruleCode: 'RANGE_CHECK',    severity: 'warning', issueType: 'out_of_range',   message: 'age > 150' },
      ]
    );

    resultId = result.id;
    expect(result.isValid).toBe(false);
    expect(result.errorCount).toBe(2);
    expect(result.warningCount).toBe(1);
    expect(issues).toHaveLength(3);
    expect(issues[0].ruleCode).toBe('REQUIRED_FIELD');
    expect(issues[0].resolutionStatus).toBe('open');
  });

  it('findById returns the result', async () => {
    const found = await valRepo.findById(ctx1, resultId);
    expect(found.collectionRunId).toBe(runId);
    expect(found.correlationId).toBe('00000000-aaaa-0000-0000-000000000004');
  });

  it('listByCollectionRun returns results for the run', async () => {
    const list = await valRepo.listByCollectionRun(ctx1, runId);
    expect(list.map((r) => r.id)).toContain(resultId);
  });

  it('listIssues returns all issues for result', async () => {
    const issues = await valRepo.listIssues(ctx1, resultId);
    expect(issues).toHaveLength(3);
    const codes = issues.map((i) => i.ruleCode);
    expect(codes).toContain('REQUIRED_FIELD');
    expect(codes).toContain('FORMAT_CHECK');
    expect(codes).toContain('RANGE_CHECK');
  });

  it('throws NotFoundError for unknown result', async () => {
    await expect(
      valRepo.findById(ctx1, '00000000-0000-0000-0000-deadbeef0004')
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('tenant isolation: ctx2 cannot see ctx1 validation result', async () => {
    await expect(
      valRepo.findById(ctx2, resultId)
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe.runIf(RUN)('Integration: DataQualityScoreRepository', () => {
  const srcRepo   = new DataSourceRepository();
  const scoreRepo = new DataQualityScoreRepository();
  let sourceId: string;
  let scoreId: string;

  beforeAll(setupIntegration);
  afterAll(teardownIntegration);

  it('creates a quality score with all dimension scores', async () => {
    const src = await srcRepo.create(ctx1, {
      name: 'QS Src', sourceCode: uniqueCode('qs-src'), sourceType: 'database', sensitivityLevel: 'confidential',
    });
    sourceId = src.id;

    const score = await scoreRepo.create(ctx1, {
      dataSourceId: sourceId,
      scopeType:    'source',
      completeness: 0.98,
      validity:     0.95,
      consistency:  0.92,
      timeliness:   0.90,
      uniqueness:   0.99,
      conformity:   0.94,
      overallScore: 0.95,
      correlationId: '00000000-aaaa-0000-0000-000000000005',
    });
    scoreId = score.id;

    expect(score.overallScore).toBeCloseTo(0.95);
    expect(score.completeness).toBeCloseTo(0.98);
    expect(score.dataSourceId).toBe(sourceId);
  });

  it('findById returns the score', async () => {
    const found = await scoreRepo.findById(ctx1, scoreId);
    expect(found.id).toBe(scoreId);
    expect(found.correlationId).toBe('00000000-aaaa-0000-0000-000000000005');
  });

  it('latestForSource returns the most recent score', async () => {
    const latest = await scoreRepo.latestForSource(ctx1, sourceId);
    expect(latest).not.toBeNull();
    expect(latest!.id).toBe(scoreId);
  });

  it('latestForSource returns null for unknown source', async () => {
    const latest = await scoreRepo.latestForSource(ctx1, '00000000-0000-0000-0000-deadbeef0005');
    expect(latest).toBeNull();
  });

  it('throws NotFoundError for unknown score id', async () => {
    await expect(
      scoreRepo.findById(ctx1, '00000000-0000-0000-0000-deadbeef0006')
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('tenant isolation: ctx2 cannot see ctx1 score', async () => {
    await expect(
      scoreRepo.findById(ctx2, scoreId)
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('scores outside 0-1 are rejected by the database', async () => {
    await expect(
      scoreRepo.create(ctx1, {
        dataSourceId: sourceId, scopeType: 'source',
        completeness: 1.5, validity: 0.9, consistency: 0.9,
        timeliness: 0.9, uniqueness: 0.9, conformity: 0.9, overallScore: 0.9,
      })
    ).rejects.toThrow();
  });
});

describe.runIf(RUN)('Integration: ProvenanceRepository', () => {
  const srcRepo  = new DataSourceRepository();
  const provRepo = new ProvenanceRepository();
  let sourceId: string;
  let rootId: string;
  let childId: string;

  beforeAll(setupIntegration);
  afterAll(teardownIntegration);

  it('creates root provenance record with lineage_depth 0', async () => {
    const src = await srcRepo.create(ctx1, {
      name: 'Prov Src', sourceCode: uniqueCode('prov-src'), sourceType: 'api', sensitivityLevel: 'restricted',
    });
    sourceId = src.id;

    const { provenance, transformations } = await provRepo.create(
      ctx1,
      {
        dataSourceId:    sourceId,
        recordReference: 'rec-001',
        sourceReference: 'upstream/feed/001',
        sourceHash:      'sha256:abc123',
        correlationId:   '00000000-aaaa-0000-0000-000000000006',
      },
      [
        {
          transformationType: 'normalise',
          transformationVersion: '1.0',
          inputHash:  'sha256:raw001',
          outputHash: 'sha256:norm001',
          performedByType: 'pipeline',
        },
      ]
    );

    rootId = provenance.id;
    expect(provenance.lineageDepth).toBe(0);
    expect(provenance.parentProvenanceId).toBeNull();
    expect(transformations).toHaveLength(1);
    expect(transformations[0].transformationType).toBe('normalise');
  });

  it('creates child provenance record with lineage_depth 1', async () => {
    const { provenance: child } = await provRepo.create(ctx1, {
      dataSourceId:      sourceId,
      recordReference:   'rec-002',
      sourceReference:   'upstream/feed/002',
      parentProvenanceId: rootId,
      correlationId:     '00000000-aaaa-0000-0000-000000000007',
    });

    childId = child.id;
    expect(child.lineageDepth).toBe(1);
    expect(child.parentProvenanceId).toBe(rootId);
  });

  it('findById returns the record', async () => {
    const found = await provRepo.findById(ctx1, rootId);
    expect(found.recordReference).toBe('rec-001');
    expect(found.correlationId).toBe('00000000-aaaa-0000-0000-000000000006');
  });

  it('listTransformations returns the transformation records', async () => {
    const trs = await provRepo.listTransformations(ctx1, rootId);
    expect(trs).toHaveLength(1);
    expect(trs[0].transformationType).toBe('normalise');
  });

  it('listTransformations returns empty for child with no transformations', async () => {
    const trs = await provRepo.listTransformations(ctx1, childId);
    expect(trs).toHaveLength(0);
  });

  it('rejects a parentProvenanceId that does not resolve, rather than silently defaulting to depth 0', async () => {
    // BUILD-31 §4.11: "reject missing parent provenance rather than
    // silently creating incorrect lineage."
    await expect(
      provRepo.create(ctx1, {
        dataSourceId: sourceId,
        recordReference: 'rec-orphan',
        sourceReference: 'upstream/feed/orphan',
        parentProvenanceId: '00000000-0000-0000-0000-deadbeef0006',
      })
    ).rejects.toBeInstanceOf(ProvenanceError);
  });

  it('enforces the maximum lineage depth', async () => {
    // rootId is depth 0, childId (created above) is depth 1 — walk the rest
    // of the way to MAX_LINEAGE_DEPTH from there.
    let parentId = childId;
    for (let depth = 2; depth <= MAX_LINEAGE_DEPTH; depth++) {
      const { provenance } = await provRepo.create(ctx1, {
        dataSourceId: sourceId,
        recordReference: 'rec-depth-' + depth,
        sourceReference: 'upstream/feed/depth-' + depth,
        parentProvenanceId: parentId,
      });
      expect(provenance.lineageDepth).toBe(depth);
      parentId = provenance.id;
    }

    // parentId is now at MAX_LINEAGE_DEPTH; one more child would exceed it.
    await expect(
      provRepo.create(ctx1, {
        dataSourceId: sourceId,
        recordReference: 'rec-too-deep',
        sourceReference: 'upstream/feed/too-deep',
        parentProvenanceId: parentId,
      })
    ).rejects.toBeInstanceOf(ProvenanceError);
  }, 20000);

  it('listByCollectionRun lists provenance scoped to one run', async () => {
    const runRepo = new CollectionRunRepository();
    const run = await runRepo.create(ctx1, { dataSourceId: sourceId, collectionType: 'api' });
    const { provenance } = await provRepo.create(ctx1, {
      dataSourceId: sourceId,
      collectionRunId: run.id,
      recordReference: 'rec-run-scoped',
      sourceReference: 'upstream/feed/run-scoped',
    });

    const list = await provRepo.listByCollectionRun(ctx1, run.id);
    expect(list.map((p) => p.id)).toEqual([provenance.id]);
  });

  it('throws NotFoundError for unknown provenance id', async () => {
    await expect(
      provRepo.findById(ctx1, '00000000-0000-0000-0000-deadbeef0007')
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('tenant isolation: ctx2 cannot see ctx1 provenance', async () => {
    await expect(
      provRepo.findById(ctx2, rootId)
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe.runIf(RUN)('Integration: PublicationPackageRepository', () => {
  const repo = new PublicationPackageRepository();
  const srcRepo = new DataSourceRepository();
  const runRepo = new CollectionRunRepository();
  let draftId: string;
  let readyId: string;
  let validatedRunId: string;

  beforeAll(async () => {
    await setupIntegration();

    // A source and a run walked all the way to `validated`, mirroring the
    // CollectionRunRepository suite's newValidated() helper — publishOn now
    // requires a real validated run (BUILD-31 §6.7: package and run
    // transition to published atomically), and publication_packages has no
    // collection_run_id column of its own (0019_create_da_publication_
    // deployment.sql) to derive one from.
    const src = await srcRepo.create(ctx1, {
      name: 'Publication Src', sourceCode: uniqueCode('pub-src'), sourceType: 'api', sensitivityLevel: 'internal',
    });
    let run = await runRepo.create(ctx1, { dataSourceId: src.id, collectionType: 'api' });
    run = await runRepo.markStarted(ctx1, run.id);
    run = await runRepo.markCompleted(ctx1, run.id, {
      recordsReceived: 10, recordsAccepted: 9, recordsRejected: 1, bytesReceived: 1024,
    });
    run = await runRepo.markValidated(ctx1, run.id);
    validatedRunId = run.id;
  });
  afterAll(teardownIntegration);

  it('creates a draft publication package', async () => {
    const pkg = await repo.create(ctx1, {
      packageType:  'full_extract',
      targetLayer:  'business_operations',
      targetBlock:  'bo-01',
      recordCount:  500,
      qualityScore: 0.95,
      correlationId: '00000000-aaaa-0000-0000-000000000008',
    });
    draftId = pkg.id;

    expect(pkg.status).toBe('draft');
    expect(pkg.targetLayer).toBe('business_operations');
    expect(pkg.recordCount).toBe(500);
    expect(pkg.qualityScore).toBeCloseTo(0.95);
    expect(pkg.publishedAt).toBeNull();
  });

  it('findById retrieves the package', async () => {
    const found = await repo.findById(ctx1, draftId);
    expect(found.correlationId).toBe('00000000-aaaa-0000-0000-000000000008');
  });

  it('listByTargetLayer returns the package', async () => {
    const list = await repo.listByTargetLayer(ctx1, 'business_operations');
    expect(list.map((p) => p.id)).toContain(draftId);
  });

  it('publish rejects draft (requires ready status)', async () => {
    // A package that exists but is in the wrong state must raise
    // InvalidStateTransitionError, not NotFoundError — BUILD-31 §4.6: "A
    // generic not-found error must not be used for an invalid transition
    // when the record exists."
    await expect(repo.publish(ctx1, draftId, validatedRunId)).rejects.toBeInstanceOf(InvalidStateTransitionError);
  });

  it('publish succeeds when package is in ready status', async () => {
    const ready = await repo.create(ctx1, {
      packageType:  'delta',
      targetLayer:  'business_intelligence',
      targetBlock:  'bi-01',
      recordCount:  200,
      status:       'ready',
      correlationId: '00000000-aaaa-0000-0000-000000000009',
    });
    readyId = ready.id;

    const published = await repo.publish(ctx1, readyId, validatedRunId);
    expect(published.status).toBe('published');
    expect(published.publishedAt).not.toBeNull();

    const run = await runRepo.findById(ctx1, validatedRunId);
    expect(run.state).toBe('published');
  });

  it('publish rejects a run that is not validated', async () => {
    const ready = await repo.create(ctx1, {
      packageType: 'delta', targetLayer: 'business_intelligence', targetBlock: 'bi-01',
      recordCount: 1, status: 'ready',
    });
    const planned = await runRepo.create(ctx1, { dataSourceId: (await srcRepo.create(ctx1, {
      name: 'Unvalidated Src', sourceCode: uniqueCode('unval-src'), sourceType: 'api', sensitivityLevel: 'internal',
    })).id, collectionType: 'api' });

    await expect(repo.publish(ctx1, ready.id, planned.id)).rejects.toBeInstanceOf(InvalidStateTransitionError);
  });

  it('revoke sets status to revoked', async () => {
    const revoked = await repo.revoke(ctx1, readyId);
    expect(revoked.status).toBe('revoked');
  });

  it('throws NotFoundError for unknown package', async () => {
    await expect(
      repo.findById(ctx1, '00000000-0000-0000-0000-deadbeef0008')
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('tenant isolation: ctx2 cannot see ctx1 package', async () => {
    await expect(
      repo.findById(ctx2, draftId)
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('correlation ID is preserved on the package', async () => {
    const found = await repo.findById(ctx1, draftId);
    expect(found.correlationId).toBe('00000000-aaaa-0000-0000-000000000008');
  });
});

describe.runIf(RUN)('Integration: ManualSubmissionRepository', () => {
  const srcRepo = new DataSourceRepository();
  const runRepo = new CollectionRunRepository();
  const msRepo  = new ManualSubmissionRepository();

  const ABSENT_ID = '00000000-0000-0000-0000-deadbeef0009';

  // Same tenant, non-existent workspace. manual_submissions_isolation predicates
  // on BOTH tenant_id and workspace_id, so this isolates the workspace dimension
  // independently of the tenant one. Matches the convention already used by the
  // DataSourceRepository block.
  const wrongWorkspaceCtx = { ...ctx1, workspaceId: '00000000-0000-0000-dead-beef00000009' };

  // BYPASSRLS pool, needed to seed platform.businesses and identity.users, and
  // to remove this block's manual_submissions rows before teardownIntegration
  // (collection_run_id is ON DELETE RESTRICT, so leftover submissions would
  // block the collection_runs delete).
  let adminPool: Pool | null = null;

  let businessId: string;
  let sourceId: string;
  let ctx2SourceId: string;

  beforeAll(async () => {
    await setupIntegration();

    // ADMIN_DATABASE_URL only — no DATABASE_URL fallback.
    adminPool = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });

    const biz = await adminPool.query<{ id: string }>(
      `INSERT INTO platform.businesses
         (tenant_id, workspace_id, legal_name, business_code, status)
       VALUES ($1,$2,'DA Manual Submission Biz',$3,'active')
       RETURNING id`,
      [T1, WS1, uniqueCode('da-ms-biz')]
    );
    businessId = biz.rows[0].id;

    // Shared user fixture, following the established convention used by the
    // aba/adi/bi/cl/dt/om suites. Not deleted in teardown, by that convention.
    await adminPool.query(
      `INSERT INTO identity.users (id, email, status)
       VALUES ($1,'da-manual-submitter@example.test','active')
       ON CONFLICT (id) DO NOTHING`,
      [UID]
    );

    const src = await srcRepo.create(ctx1, {
      name: 'Manual Src', sourceCode: uniqueCode('manual-src'), sourceType: 'manual', sensitivityLevel: 'internal',
    });
    sourceId = src.id;

    // A source owned legitimately by tenant 2 / workspace 2, so the isolation
    // test can build a fully FK-valid row for that tenant rather than
    // manufacturing inconsistent tenant/workspace values.
    const ctx2Src = await srcRepo.create(ctx2, {
      name: 'Manual Src T2', sourceCode: uniqueCode('manual-src-t2'), sourceType: 'manual', sensitivityLevel: 'internal',
    });
    ctx2SourceId = ctx2Src.id;
  });

  afterAll(async () => {
    try {
      try {
        try {
          if (adminPool) {
            // Must precede teardownIntegration: manual_submissions.collection_run_id
            // is ON DELETE RESTRICT, so leftover rows would block its
            // collection_runs delete.
            await adminPool.query(
              'DELETE FROM data_acquisition.manual_submissions WHERE tenant_id = ANY($1)',
              [[ctx1.tenantId, ctx2.tenantId]]
            );
          }
        } finally {
          if (adminPool && businessId) {
            await adminPool.query('DELETE FROM platform.businesses WHERE id = $1', [businessId]);
          }
        }
      } finally {
        if (adminPool) await adminPool.end();
        adminPool = null;
      }
    } finally {
      await teardownIntegration();
    }
  });

  // ── fixtures: every test builds its own run and submission ─────────────────

  async function newRun() {
    return runRepo.create(ctx1, { dataSourceId: sourceId, collectionType: 'manual' });
  }

  async function newRunCtx2() {
    return runRepo.create(ctx2, { dataSourceId: ctx2SourceId, collectionType: 'manual' });
  }

  async function newSubmission(
    overrides: Partial<Parameters<ManualSubmissionRepository['create']>[1]> = {}
  ) {
    const run = await newRun();
    return msRepo.create(ctx1, {
      dataSourceId:    sourceId,
      collectionRunId: run.id,
      submissionType:  'manual_json',
      ...overrides,
    });
  }

  /** Raw read against the app connection; data_acquisition is app-role readable. */
  async function jsonbTypeOf(id: string): Promise<string> {
    return withTenantTransaction(ctx1, async (client) => {
      const res = await client.query<{ t: string }>(
        `SELECT jsonb_typeof(payload) AS t
           FROM data_acquisition.manual_submissions
          WHERE id = $1`,
        [id]
      );
      return res.rows[0].t;
    });
  }

  // ── create() ──────────────────────────────────────────────────────────────

  it('creates a submission', async () => {
    const run = await newRun();
    const sub = await msRepo.create(ctx1, {
      dataSourceId:    sourceId,
      collectionRunId: run.id,
      submissionType:  'manual_json',
    });
    expect(sub.id).toBeTruthy();
    expect(sub.dataSourceId).toBe(sourceId);
    expect(sub.collectionRunId).toBe(run.id);
    expect(sub.submissionType).toBe('manual_json');
  });

  it('defaults status to submitted', async () => {
    const sub = await newSubmission();
    expect(sub.status).toBe('submitted');
  });

  it('defaults revisionNumber to 1', async () => {
    const sub = await newSubmission();
    expect(sub.revisionNumber).toBe(1);
  });

  it('defaults parentSubmissionId to null', async () => {
    const sub = await newSubmission();
    expect(sub.parentSubmissionId).toBeNull();
  });

  it('preserves a supplied correlationId', async () => {
    const sub = await newSubmission({ correlationId: '00000000-aaaa-0000-0000-000000000009' });
    expect(sub.correlationId).toBe('00000000-aaaa-0000-0000-000000000009');
  });

  it('generates a correlationId when omitted', async () => {
    const a = await newSubmission();
    const b = await newSubmission();
    expect(a.correlationId).toBeTruthy();
    expect(b.correlationId).toBeTruthy();
    expect(a.correlationId).not.toBe(b.correlationId);
  });

  it('preserves submissionNotes', async () => {
    const sub = await newSubmission({ submissionNotes: 'batch from finance team' });
    expect(sub.submissionNotes).toBe('batch from finance team');
  });

  it('preserves businessId when supplied', async () => {
    const sub = await newSubmission({ businessId });
    expect(sub.businessId).toBe(businessId);
  });

  it('preserves submittedBy when supplied', async () => {
    const sub = await newSubmission({ submittedBy: UID });
    expect(sub.submittedBy).toBe(UID);
  });

  it('round-trips an object payload', async () => {
    const payload = { records: [{ sku: 'A1', qty: 3 }], batch: 'b-01' };
    const sub = await newSubmission({ payload });
    expect(sub.payload).toEqual(payload);
  });

  it('round-trips an array payload', async () => {
    const payload = [{ sku: 'A1' }, { sku: 'B2' }];
    const sub = await newSubmission({ payload });
    expect(sub.payload).toEqual(payload);
  });

  it('round-trips a numeric scalar payload', async () => {
    const sub = await newSubmission({ payload: 42 });
    expect(sub.payload).toBe(42);
  });

  it('round-trips an explicit JSON null payload', async () => {
    const sub = await newSubmission({ payload: null });
    expect(sub.payload).toBeNull();
    // Distinguishes JSON null from SQL NULL, which pg would surface identically.
    expect(await jsonbTypeOf(sub.id)).toBe('null');
  });

  it('writes an empty object when payload is omitted', async () => {
    const sub = await newSubmission();
    expect(sub.payload).toEqual({});
  });

  // ── findById() ────────────────────────────────────────────────────────────

  it('findById retrieves the submission', async () => {
    const created = await newSubmission();
    const found = await msRepo.findById(ctx1, created.id);
    expect(found.id).toBe(created.id);
  });

  it('findById throws NotFoundError for an unknown id', async () => {
    await expect(
      msRepo.findById(ctx1, ABSENT_ID)
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('findById is tenant-isolated', async () => {
    const created = await newSubmission();
    await expect(
      msRepo.findById(ctx2, created.id)
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('findById is workspace-isolated within the same tenant', async () => {
    const created = await newSubmission();
    await expect(
      msRepo.findById(wrongWorkspaceCtx, created.id)
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  // ── listByCollectionRun() ─────────────────────────────────────────────────

  it('listByCollectionRun returns only the requested run', async () => {
    const runA = await newRun();
    const runB = await newRun();
    const inA = await msRepo.create(ctx1, {
      dataSourceId: sourceId, collectionRunId: runA.id, submissionType: 'manual_json',
    });
    await msRepo.create(ctx1, {
      dataSourceId: sourceId, collectionRunId: runB.id, submissionType: 'manual_json',
    });

    const list = await msRepo.listByCollectionRun(ctx1, runA.id);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(inA.id);
  });

  it('listByCollectionRun orders newest first', async () => {
    const run = await newRun();
    const first  = await msRepo.create(ctx1, { dataSourceId: sourceId, collectionRunId: run.id, submissionType: 'manual_json' });
    const second = await msRepo.create(ctx1, { dataSourceId: sourceId, collectionRunId: run.id, submissionType: 'manual_json' });
    const third  = await msRepo.create(ctx1, { dataSourceId: sourceId, collectionRunId: run.id, submissionType: 'manual_json' });

    // The production query orders only by created_at DESC, so equal timestamps
    // would leave relative order unspecified. Stamp these three rows — and only
    // these three, by id — with explicitly distinct times so the assertion is
    // deterministic without relying on transaction-clock resolution or sleeps.
    await withTenantTransaction(ctx1, async (client) => {
      const stamps: Array<[string, string]> = [
        [first.id,  '2026-01-01T00:00:01.000Z'],
        [second.id, '2026-01-01T00:00:02.000Z'],
        [third.id,  '2026-01-01T00:00:03.000Z'],
      ];
      for (const [id, at] of stamps) {
        await client.query(
          'UPDATE data_acquisition.manual_submissions SET created_at = $2 WHERE id = $1',
          [id, at]
        );
      }
    });

    const list = await msRepo.listByCollectionRun(ctx1, run.id);
    expect(list.map((s) => s.id)).toEqual([third.id, second.id, first.id]);
  });

  it('listByCollectionRun respects limit', async () => {
    const run = await newRun();
    for (let i = 0; i < 3; i++) {
      await msRepo.create(ctx1, { dataSourceId: sourceId, collectionRunId: run.id, submissionType: 'manual_json' });
    }
    const page = await msRepo.listByCollectionRun(ctx1, run.id, { limit: 2 });
    expect(page).toHaveLength(2);
  });

  it('listByCollectionRun respects offset', async () => {
    const run = await newRun();
    for (let i = 0; i < 3; i++) {
      await msRepo.create(ctx1, { dataSourceId: sourceId, collectionRunId: run.id, submissionType: 'manual_json' });
    }
    const firstPage  = await msRepo.listByCollectionRun(ctx1, run.id, { limit: 2 });
    const secondPage = await msRepo.listByCollectionRun(ctx1, run.id, { limit: 2, offset: 2 });
    expect(secondPage).toHaveLength(1);
    expect(firstPage.map((s) => s.id)).not.toContain(secondPage[0].id);
  });

  it('listByCollectionRun excludes rows from another tenant/workspace', async () => {
    // Fully FK-valid row owned by tenant 2: its source and run both belong to
    // ctx2, so nothing inconsistent is manufactured to exercise RLS.
    const ctx2Run = await newRunCtx2();
    await msRepo.create(ctx2, {
      dataSourceId: ctx2SourceId, collectionRunId: ctx2Run.id, submissionType: 'manual_json',
    });

    expect(await msRepo.listByCollectionRun(ctx1, ctx2Run.id)).toHaveLength(0);
    expect(await msRepo.listByCollectionRun(wrongWorkspaceCtx, ctx2Run.id)).toHaveLength(0);
    expect(await msRepo.listByCollectionRun(ctx2, ctx2Run.id)).toHaveLength(1);
  });

  // ── updateStatus() ────────────────────────────────────────────────────────
  //
  // The edges exercised below are caller-selected compare-and-set operations.
  // They are NOT a claim that any of them form a frozen lifecycle policy —
  // BUILD-31 defines no transition matrix for manual submissions.

  it('updateStatus moves submitted -> reviewing when the expected status matches', async () => {
    const sub = await newSubmission();
    const updated = await msRepo.updateStatus(ctx1, sub.id, 'submitted', 'reviewing');
    expect(updated.status).toBe('reviewing');
  });

  it('updateStatus moves reviewing -> accepted when the expected status matches', async () => {
    const sub = await newSubmission();
    await msRepo.updateStatus(ctx1, sub.id, 'submitted', 'reviewing');
    const updated = await msRepo.updateStatus(ctx1, sub.id, 'reviewing', 'accepted');
    expect(updated.status).toBe('accepted');
  });

  it('updateStatus permits a self-transition when the expected status matches', async () => {
    const sub = await newSubmission();
    const updated = await msRepo.updateStatus(ctx1, sub.id, 'submitted', 'submitted');
    expect(updated.status).toBe('submitted');
  });

  it('updateStatus throws InvalidStateTransitionError when the persisted status differs', async () => {
    const sub = await newSubmission();
    await expect(
      msRepo.updateStatus(ctx1, sub.id, 'accepted', 'rejected')
    ).rejects.toBeInstanceOf(InvalidStateTransitionError);
  });

  it('updateStatus throws NotFoundError for an unknown id', async () => {
    await expect(
      msRepo.updateStatus(ctx1, ABSENT_ID, 'submitted', 'reviewing')
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('updateStatus throws NotFoundError for an inaccessible id', async () => {
    const sub = await newSubmission();
    await expect(
      msRepo.updateStatus(ctx2, sub.id, 'submitted', 'reviewing')
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      msRepo.updateStatus(wrongWorkspaceCtx, sub.id, 'submitted', 'reviewing')
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  // The casts below are a deliberate test-only escape so a runtime-invalid
  // value can reach the method. Production signatures stay narrowed.
  it('updateStatus throws ValidationError for an invalid expectedStatus', async () => {
    await expect(
      msRepo.updateStatus(ctx1, ABSENT_ID, 'not_a_status' as ManualSubmissionStatus, 'reviewing')
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('updateStatus throws ValidationError for an invalid nextStatus', async () => {
    await expect(
      msRepo.updateStatus(ctx1, ABSENT_ID, 'submitted', 'not_a_status' as ManualSubmissionStatus)
    ).rejects.toBeInstanceOf(ValidationError);
  });

  // ── permitted status set ──────────────────────────────────────────────────

  it('MANUAL_SUBMISSION_STATUSES matches manual_submissions_status_check', () => {
    expect([...MANUAL_SUBMISSION_STATUSES]).toEqual([
      'submitted',
      'reviewing',
      'accepted',
      'rejected',
      'superseded',
    ]);
  });
});

describe.runIf(RUN)('Schema: manual_submissions_status_check', () => {
  const srcRepo = new DataSourceRepository();
  const runRepo = new CollectionRunRepository();

  let adminPool: Pool | null = null;
  let sourceId: string;
  let runId: string;

  beforeAll(async () => {
    await setupIntegration();

    // ADMIN_DATABASE_URL only — no DATABASE_URL fallback.
    adminPool = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });

    const src = await srcRepo.create(ctx1, {
      name: 'Status Probe Src', sourceCode: uniqueCode('status-probe'), sourceType: 'manual', sensitivityLevel: 'internal',
    });
    sourceId = src.id;

    const run = await runRepo.create(ctx1, { dataSourceId: sourceId, collectionType: 'manual' });
    runId = run.id;
  });

  afterAll(async () => {
    try {
      try {
        if (adminPool) {
          await adminPool.query(
            'DELETE FROM data_acquisition.manual_submissions WHERE tenant_id = ANY($1)',
            [[ctx1.tenantId]]
          );
        }
      } finally {
        if (adminPool) await adminPool.end();
        adminPool = null;
      }
    } finally {
      await teardownIntegration();
    }
  });

  it('accepts every permitted status on a direct INSERT', async () => {
    for (const status of ['submitted', 'reviewing', 'accepted', 'rejected', 'superseded']) {
      await withTenantTransaction(ctx1, async (client) => {
        const res = await client.query<{ status: string }>(
          `INSERT INTO data_acquisition.manual_submissions
             (tenant_id, workspace_id, data_source_id, collection_run_id, submission_type, status)
           VALUES ($1,$2,$3,$4,'manual_json',$5) RETURNING status`,
          [ctx1.tenantId, ctx1.workspaceId, sourceId, runId, status]
        );
        expect(res.rows[0].status).toBe(status);
      });
    }
  });

  // Defence in depth: the repository validates first, but the database must
  // still reject an unsupported status for any writer that bypasses it.
  it('rejects an unsupported status on a direct INSERT', async () => {
    await expect(
      withTenantTransaction(ctx1, async (client) => {
        await client.query(
          `INSERT INTO data_acquisition.manual_submissions
             (tenant_id, workspace_id, data_source_id, collection_run_id, submission_type, status)
           VALUES ($1,$2,$3,$4,'manual_json','not_a_status')`,
          [ctx1.tenantId, ctx1.workspaceId, sourceId, runId]
        );
      })
    ).rejects.toThrow(/manual_submissions_status_check/);
  });
});

/**
 * BUILD-31 §4.5 — client-scoped composition.
 *
 * Every suite above exercises the public repository methods, each of which
 * opens its own transaction. None of them calls an `*On` method with a
 * caller-supplied client, so the composition path this prerequisite exists to
 * enable is otherwise unexercised. This block covers exactly that:
 *
 *   - several repositories composed onto ONE client inside ONE transaction;
 *   - a mid-sequence failure rolling back the domain writes and the outbox
 *     event emitted earlier in that same transaction, together — the case the
 *     CollectionRunRepository block explicitly records as untested, because a
 *     rejected guard there fails before any emitter is reached;
 *   - the transaction-local RLS GUCs, not the `ctx` argument, deciding what an
 *     `*On` read can reach.
 *
 * No assertion is made about da.validation.completed or da.data.quality_scored:
 * those emitters exist in outbox.ts but have no call site, and wiring them is a
 * separate BUILD-31 change.
 */
describe.runIf(RUN)('Integration: BUILD-31 §4.5 client-scoped composition', () => {
  const srcRepo  = new DataSourceRepository();
  const connRepo = new ConnectorRepository();
  const runRepo  = new CollectionRunRepository();
  const msRepo   = new ManualSubmissionRepository();
  const vrRepo   = new ValidationResultRepository();
  const dqsRepo  = new DataQualityScoreRepository();
  const provRepo = new ProvenanceRepository();

  // BYPASSRLS pool, for the two things the app role cannot do: reading
  // events.outbox_events (app_test_user has no USAGE on the events schema) and
  // removing this block's manual_submissions before teardownIntegration
  // (collection_run_id is ON DELETE RESTRICT, so leftovers would block its
  // collection_runs delete). Everything else goes through the app role.
  let adminPool: Pool | null = null;

  let sourceId: string;
  let connectorId: string;
  let ctx2SourceId: string;
  let ctx2ConnectorId: string;

  beforeAll(async () => {
    await setupIntegration();

    // ADMIN_DATABASE_URL only — no DATABASE_URL fallback.
    adminPool = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });

    const src = await srcRepo.create(ctx1, {
      name:             'Composition Source',
      sourceCode:       uniqueCode('compose-src'),
      sourceType:       'manual',
      sensitivityLevel: 'internal',
    });
    sourceId = src.id;

    const conn = await connRepo.create(ctx1, {
      dataSourceId:  sourceId,
      name:          'Composition manual intake',
      connectorType: 'manual_json',
    });
    connectorId = conn.id;

    // Owned legitimately by tenant 2 / workspace 2 and created through the
    // public method, so their own GUCs are correct and no inconsistent
    // tenant/workspace values are manufactured. The isolation tests reach for
    // these from a tenant-1 transaction.
    const ctx2Src = await srcRepo.create(ctx2, {
      name:             'Composition Source T2',
      sourceCode:       uniqueCode('compose-src-t2'),
      sourceType:       'manual',
      sensitivityLevel: 'internal',
    });
    ctx2SourceId = ctx2Src.id;

    const ctx2Conn = await connRepo.create(ctx2, {
      dataSourceId:  ctx2SourceId,
      name:          'Composition manual intake T2',
      connectorType: 'manual_json',
    });
    ctx2ConnectorId = ctx2Conn.id;
  });

  afterAll(async () => {
    try {
      try {
        if (adminPool) {
          await adminPool.query(
            'DELETE FROM data_acquisition.manual_submissions WHERE tenant_id = ANY($1)',
            [[ctx1.tenantId, ctx2.tenantId]]
          );
        }
      } finally {
        if (adminPool) await adminPool.end();
        adminPool = null;
      }
    } finally {
      await teardownIntegration();
    }
  });

  /**
   * Outbox rows for one aggregate, read through adminPool for the same reason
   * the CollectionRunRepository block reads them that way. BYPASSRLS means
   * outbox_events_isolation is not enforcing tenancy on this connection, so
   * tenant_id and workspace_id are asserted in the predicate rather than
   * relied upon.
   */
  async function eventsFor(runId: string, eventType: string) {
    if (!adminPool) {
      throw new Error('eventsFor requires adminPool; beforeAll did not run');
    }
    const res = await adminPool.query<Record<string, unknown>>(
      `SELECT event_type, aggregate_type, aggregate_id, status
         FROM events.outbox_events
        WHERE tenant_id    = $1
          AND workspace_id = $2
          AND aggregate_id = $3
          AND event_type   = $4`,
      [ctx1.tenantId, ctx1.workspaceId, runId, eventType]
    );
    return res.rows;
  }

  // 122
  it('composes the manual-intake path across seven repositories in one transaction', async () => {
    const composed = await withTenantTransaction(ctx1, async (client) => {
      // 1 — source reachable on this client
      const source = await srcRepo.findByIdOn(client, ctx1, sourceId);
      expect(source.id).toBe(sourceId);

      // 2 — connector must belong to that source
      const connector = await connRepo.findByIdForSourceOn(client, ctx1, sourceId, connectorId);
      expect(connector.id).toBe(connectorId);

      // 3 — planned
      const run = await runRepo.createOn(client, ctx1, {
        dataSourceId:   sourceId,
        connectorId,
        collectionType: 'manual',
      });
      expect(run.state).toBe('planned');

      // 4 — planned -> collecting; emits da.collection.started on THIS client
      const started = await runRepo.markStartedOn(client, ctx1, run.id);
      expect(started.state).toBe('collecting');

      // 5
      const submission = await msRepo.createOn(client, ctx1, {
        dataSourceId:    sourceId,
        collectionRunId: run.id,
        submissionType:  'manual_json',
        payload:         { records: [{ sku: 'A-1' }, { sku: 'A-2' }, { sku: 'A-3' }] },
      });

      // 6
      const { result: validation } = await vrRepo.createOn(client, ctx1, {
        collectionRunId: run.id,
        isValid:         true,
        errorCount:      0,
        warningCount:    0,
      });

      // 7
      const score = await dqsRepo.createOn(client, ctx1, {
        dataSourceId:    sourceId,
        collectionRunId: run.id,
        completeness: 1,
        validity:     1,
        consistency:  1,
        timeliness:   1,
        uniqueness:   1,
        conformity:   1,
        overallScore: 1,
      });

      // 8
      const { provenance } = await provRepo.createOn(client, ctx1, {
        dataSourceId:    sourceId,
        collectionRunId: run.id,
        recordReference: 'sku:A-1',
        sourceReference: 'upload:composition-1',
      });

      // 9 — collecting -> collected; emits da.collection.completed
      const completed = await runRepo.markCompletedOn(client, ctx1, run.id, {
        recordsReceived: 3,
        recordsAccepted: 3,
        recordsRejected: 0,
        bytesReceived:   512,
      });
      expect(completed.state).toBe('collected');

      // 10 — collected -> validated; emits nothing, by design
      const validated = await runRepo.markValidatedOn(client, ctx1, run.id);
      expect(validated.state).toBe('validated');

      return {
        runId:        run.id,
        submissionId: submission.id,
        validationId: validation.id,
        scoreId:      score.id,
        provenanceId: provenance.id,
      };
    });

    // Committed state, re-read on a fresh transaction and connection.
    const persisted = await withTenantTransaction(ctx1, async (client) => ({
      run: (await client.query<Record<string, unknown>>(
        'SELECT state FROM data_acquisition.collection_runs WHERE id = $1', [composed.runId])).rows,
      submission: (await client.query<Record<string, unknown>>(
        'SELECT id FROM data_acquisition.manual_submissions WHERE id = $1', [composed.submissionId])).rows,
      validation: (await client.query<Record<string, unknown>>(
        'SELECT id FROM data_acquisition.validation_results WHERE id = $1', [composed.validationId])).rows,
      score: (await client.query<Record<string, unknown>>(
        'SELECT id FROM data_acquisition.data_quality_scores WHERE id = $1', [composed.scoreId])).rows,
      provenance: (await client.query<Record<string, unknown>>(
        'SELECT id FROM data_acquisition.provenance_records WHERE id = $1', [composed.provenanceId])).rows,
    }));

    expect(persisted.run).toHaveLength(1);
    expect(persisted.run[0].state).toBe('validated');
    expect(persisted.submission).toHaveLength(1);
    expect(persisted.validation).toHaveLength(1);
    expect(persisted.score).toHaveLength(1);
    expect(persisted.provenance).toHaveLength(1);

    const startedEvents = await eventsFor(composed.runId, 'da.collection.started');
    expect(startedEvents).toHaveLength(1);
    expect(startedEvents[0].aggregate_type).toBe('collection_run');

    const completedEvents = await eventsFor(composed.runId, 'da.collection.completed');
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0].aggregate_type).toBe('collection_run');
  });

  // 123
  it('rolls back domain writes and the outbox event together when a later guarded transition fails', async () => {
    let runId = '';
    let submissionId = '';

    await expect(
      withTenantTransaction(ctx1, async (client) => {
        const run = await runRepo.createOn(client, ctx1, {
          dataSourceId:   sourceId,
          connectorId,
          collectionType: 'manual',
        });
        runId = run.id;

        // The one emission in this transaction: da.collection.started, written
        // to the outbox on the same client as the state change.
        await runRepo.markStartedOn(client, ctx1, run.id);

        const submission = await msRepo.createOn(client, ctx1, {
          dataSourceId:    sourceId,
          collectionRunId: run.id,
          submissionType:  'manual_json',
          payload:         { records: [{ sku: 'B-1' }] },
        });
        submissionId = submission.id;

        // Illegal under the frozen matrix: 'validated' is reachable only from
        // 'collected' or 'quarantined', and this run is still 'collecting'.
        // Deliberately not caught here — it must escape so that
        // withTenantTransaction issues ROLLBACK rather than COMMIT.
        return runRepo.markValidatedOn(client, ctx1, run.id);
      })
    ).rejects.toBeInstanceOf(InvalidStateTransitionError);

    // Both ids were assigned before the failure, so the assertions below query
    // rows that really were written inside the rejected transaction.
    expect(runId).not.toBe('');
    expect(submissionId).not.toBe('');

    const after = await withTenantTransaction(ctx1, async (client) => ({
      run: (await client.query<Record<string, unknown>>(
        'SELECT id FROM data_acquisition.collection_runs WHERE id = $1', [runId])).rows,
      submission: (await client.query<Record<string, unknown>>(
        'SELECT id FROM data_acquisition.manual_submissions WHERE id = $1', [submissionId])).rows,
    }));

    expect(after.run).toHaveLength(0);
    expect(after.submission).toHaveLength(0);
    expect(await eventsFor(runId, 'da.collection.started')).toHaveLength(0);
  });

  // 124
  it('denies cross-tenant access through findByIdOn under transaction-local GUCs', async () => {
    await expect(
      withTenantTransaction(ctx1, (client) => srcRepo.findByIdOn(client, ctx1, ctx2SourceId))
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  // 125
  it('treats the enclosing transaction GUCs, not the ctx argument, as the access authority', async () => {
    // Tenant-1 GUCs with the OWNING tenant-2 ctx: still denied. Passing the
    // resource's own ctx does not grant access.
    await expect(
      withTenantTransaction(ctx1, (client) =>
        connRepo.findByIdForSourceOn(client, ctx2, ctx2SourceId, ctx2ConnectorId))
    ).rejects.toBeInstanceOf(NotFoundError);

    // Tenant-2 GUCs with a FOREIGN tenant-1 ctx: still permitted. The ctx
    // argument is inert for isolation; the enclosing transaction decides.
    const connector = await withTenantTransaction(ctx2, (client) =>
      connRepo.findByIdForSourceOn(client, ctx1, ctx2SourceId, ctx2ConnectorId));

    expect(connector.id).toBe(ctx2ConnectorId);
    expect(connector.dataSourceId).toBe(ctx2SourceId);
    expect(connector.tenantId).toBe(ctx2.tenantId);
  });
});
