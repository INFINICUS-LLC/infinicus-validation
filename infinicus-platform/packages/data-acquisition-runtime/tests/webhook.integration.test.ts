import { createHash } from 'crypto';
import { Pool } from 'pg';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPool, closePool } from '@infinicus/database';
import { DataAcquisitionService } from '../src/DataAcquisitionService.js';
import { NotFoundError, ValidationError, WebhookAuthenticationError } from '../src/errors.js';

const RUN = !!process.env.DATABASE_URL;

// This file's own tenant/workspace/business fixture — deliberately NOT the
// shared helpers/integration.ts (module-level mutable state, one hardcoded
// tenant), which only ever had one consumer (DataAcquisitionService.
// integration.test.ts) before this file existed. Vitest runs test files
// concurrently by default; two files racing on the exact same tenant_id
// meant one file's afterAll teardown could DELETE the other's still-in-use
// rows mid-run (confirmed live: FK violations on data_sources/connectors
// under `pnpm test`, gone once each file got its own tenant). Every
// packages/database/tests/*.ts file already follows this same
// one-tenant-constant-per-file convention for the same reason.
const T1  = '55555555-7878-0000-0000-000000000001';
const WS1 = '55555555-7878-0000-0000-000000000002';
const UID = '55555555-7878-0000-0000-000000000099';
const ctx1 = { tenantId: T1, workspaceId: WS1, userId: UID };

let adminPool: Pool;
let seq = 0;
function uniqueCode(prefix: string): string {
  return `${prefix}-${Date.now()}-${++seq}`;
}

function payloadHashOf(records: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(records), 'utf8').digest('hex');
}

describe.runIf(RUN)('Integration: DataAcquisitionService webhook intake', () => {
  const svc = new DataAcquisitionService();
  let businessId: string;

  beforeAll(async () => {
    const appUrl = process.env.DATABASE_URL!;
    const adminUrl = process.env.ADMIN_DATABASE_URL ?? appUrl;
    createPool({ connectionString: appUrl });
    adminPool = new Pool({ connectionString: adminUrl });

    await adminPool.query(
      `INSERT INTO tenancy.tenants (id, name, slug, status, plan_code)
       VALUES ($1,'DA Webhook Int-Test Tenant','da-webhook-int-t1','active','test')
       ON CONFLICT (id) DO NOTHING`,
      [T1]
    );
    await adminPool.query(
      `INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status)
       VALUES ($1,$2,'DA Webhook Int-Test WS','da-webhook-int-ws1','active')
       ON CONFLICT (id) DO NOTHING`,
      [WS1, T1]
    );
    const biz = await adminPool.query<{ id: string }>(
      `INSERT INTO platform.businesses (tenant_id, workspace_id, legal_name, business_code, status)
       VALUES ($1,$2,'DA Webhook Test Biz',$3,'active')
       RETURNING id`,
      [T1, WS1, uniqueCode('da-webhook-biz')]
    );
    businessId = biz.rows[0].id;
  });

  afterAll(async () => {
    const tenantFilter = [T1];
    const clean = async (sql: string) => adminPool.query(sql, [tenantFilter]);
    await clean(`DELETE FROM data_acquisition.transformation_records
                 WHERE provenance_record_id IN (
                   SELECT id FROM data_acquisition.provenance_records WHERE tenant_id = ANY($1)
                 )`);
    await clean(`DELETE FROM data_acquisition.provenance_records       WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM data_acquisition.publication_packages     WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM data_acquisition.data_quality_scores      WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM data_acquisition.validation_issues
                 WHERE validation_result_id IN (
                   SELECT id FROM data_acquisition.validation_results WHERE tenant_id = ANY($1)
                 )`);
    await clean(`DELETE FROM data_acquisition.validation_results       WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM data_acquisition.manual_submissions       WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM data_acquisition.webhook_receipts         WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM data_acquisition.collection_runs          WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM data_acquisition.connectors               WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM data_acquisition.data_sources             WHERE tenant_id = ANY($1)`);
    await adminPool.query(`DELETE FROM platform.businesses WHERE id = $1`, [businessId]);
    await adminPool.end();
    await closePool();
  });

  async function newWebhookConnector(sourceStatus: 'active' | 'draft' = 'active') {
    const source = await svc.registerSource(ctx1, {
      businessId,
      name: 'Webhook Test Source',
      sourceCode: uniqueCode('wh-src'),
      sourceType: 'webhook',
      sensitivityLevel: 'internal',
      status: sourceStatus,
    });
    const connector = await svc.registerConnector(ctx1, businessId, source.id, {
      name: 'Webhook Connector',
      connectorType: 'webhook',
      status: 'active',
    });
    const rawToken = await svc.generateConnectorWebhookToken(ctx1, businessId, source.id, connector.id);
    return { source, connector, rawToken };
  }

  it('rejects generating a webhook token for a non-webhook connector', async () => {
    const source = await svc.registerSource(ctx1, {
      businessId, name: 'Manual Source', sourceCode: uniqueCode('m-src'), sourceType: 'api', status: 'active',
    });
    const connector = await svc.registerConnector(ctx1, businessId, source.id, {
      name: 'Manual Connector', connectorType: 'manual_json',
    });
    await expect(
      svc.generateConnectorWebhookToken(ctx1, businessId, source.id, connector.id)
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects a webhook delivery with an unknown token prefix', async () => {
    await expect(
      svc.receiveWebhook({
        tokenPrefix: 'nope', rawToken: 'nope.doesnotmatter',
        records: [{ a: 1 }], rawBody: JSON.stringify([{ a: 1 }]),
      })
    ).rejects.toBeInstanceOf(WebhookAuthenticationError);
  });

  it('rejects a webhook delivery with the right prefix but wrong secret', async () => {
    const { rawToken } = await newWebhookConnector();
    const [prefix] = rawToken.split('.');
    await expect(
      svc.receiveWebhook({
        tokenPrefix: prefix, rawToken: `${prefix}.wrongsecret`,
        records: [{ a: 1 }], rawBody: JSON.stringify([{ a: 1 }]),
      })
    ).rejects.toBeInstanceOf(WebhookAuthenticationError);
  });

  it('rejects a webhook delivery to a connector on a non-active source', async () => {
    const { rawToken } = await newWebhookConnector('draft');
    const [prefix] = rawToken.split('.');
    await expect(
      svc.receiveWebhook({
        tokenPrefix: prefix, rawToken, records: [{ a: 1 }], rawBody: JSON.stringify([{ a: 1 }]),
      })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('processes a valid webhook delivery through the same pipeline as manual intake: validated, quality-scored, provenance recorded', async () => {
    const { source, connector, rawToken } = await newWebhookConnector();
    const [prefix] = rawToken.split('.');
    const records = [{ order: 'A100', total: 42.5 }, { order: 'A101', total: 10 }];

    const result = await svc.receiveWebhook({
      tokenPrefix: prefix, rawToken, records, rawBody: JSON.stringify(records),
    });

    expect(result.replayed).toBe(false);
    expect(result.state).toBe('validated');
    expect(result.recordsReceived).toBe(2);
    expect(result.recordsAccepted).toBe(2);
    expect(result.recordsRejected).toBe(0);

    const run = await svc.getRun(ctx1, businessId, result.collectionRunId);
    expect(run.collectionType).toBe('webhook');
    expect(run.dataSourceId).toBe(source.id);
    expect(run.connectorId).toBe(connector.id);

    const score = await svc.getQualityScore(ctx1, businessId, result.collectionRunId);
    expect(score).not.toBeNull();

    const provenance = await svc.listProvenance(ctx1, businessId, result.collectionRunId);
    expect(provenance).toHaveLength(2);
  });

  it('persists only allow-listed headers in webhook_receipts and never credential-bearing ones', async () => {
    const { rawToken } = await newWebhookConnector();
    const [prefix] = rawToken.split('.');
    const records = [{ order: 'H1', total: 1 }];
    const result = await svc.receiveWebhook({
      tokenPrefix: prefix, rawToken, records, rawBody: JSON.stringify(records),
      externalEventId: 'evt-header-policy-1',
      headers: {
        authorization: 'Bearer should-not-be-stored',
        cookie: 'session=should-not-be-stored',
        'proxy-authorization': 'Basic should-not-be-stored',
        'x-api-key': 'should-not-be-stored',
        'x-gitlab-token': 'should-not-be-stored',
        host: 'api.infini-cus.com',
        'content-type': 'application/json',
        'x-event-id': 'evt-header-policy-1',
        'x-hub-signature-256': 'sha256=abc123',
      },
    });

    const row = await adminPool!.query<{ headers: Record<string, string> }>(
      `SELECT headers FROM data_acquisition.webhook_receipts WHERE collection_run_id = $1`,
      [result.collectionRunId]
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].headers).toEqual({
      'content-type': 'application/json',
      'x-event-id': 'evt-header-policy-1',
      'x-hub-signature-256': 'sha256=abc123',
    });
    expect(JSON.stringify(row.rows[0].headers)).not.toContain('should-not-be-stored');
  });

  it('replays the same outcome for a retried delivery carrying the same externalEventId, without creating a second run', async () => {
    const { rawToken } = await newWebhookConnector();
    const [prefix] = rawToken.split('.');
    const records = [{ order: 'B200', total: 5 }];
    const externalEventId = uniqueCode('evt');

    const first = await svc.receiveWebhook({
      tokenPrefix: prefix, rawToken, records, rawBody: JSON.stringify(records), externalEventId,
    });
    expect(first.replayed).toBe(false);

    const second = await svc.receiveWebhook({
      tokenPrefix: prefix, rawToken, records, rawBody: JSON.stringify(records), externalEventId,
    });
    expect(second.replayed).toBe(true);
    expect(second.collectionRunId).toBe(first.collectionRunId);
    expect(second.state).toBe(first.state);

    const runs = await svc.listRuns(ctx1, businessId, { limit: 200 });
    const matching = runs.filter((r) => r.id === first.collectionRunId);
    expect(matching).toHaveLength(1);
  });

  it('replays based on payload hash when no externalEventId is supplied (identical bytes = identical delivery)', async () => {
    const { rawToken } = await newWebhookConnector();
    const [prefix] = rawToken.split('.');
    const records = [{ order: 'C300', total: 7 }];
    const rawBody = JSON.stringify(records);
    expect(payloadHashOf(records)).toBe(createHash('sha256').update(rawBody, 'utf8').digest('hex'));

    const first = await svc.receiveWebhook({ tokenPrefix: prefix, rawToken, records, rawBody });
    const second = await svc.receiveWebhook({ tokenPrefix: prefix, rawToken, records, rawBody });
    expect(second.replayed).toBe(true);
    expect(second.collectionRunId).toBe(first.collectionRunId);
  });

  it('a different payload with no externalEventId is treated as a genuinely new delivery', async () => {
    const { rawToken } = await newWebhookConnector();
    const [prefix] = rawToken.split('.');

    const first = await svc.receiveWebhook({
      tokenPrefix: prefix, rawToken, records: [{ order: 'D1' }], rawBody: JSON.stringify([{ order: 'D1' }]),
    });
    const second = await svc.receiveWebhook({
      tokenPrefix: prefix, rawToken, records: [{ order: 'D2' }], rawBody: JSON.stringify([{ order: 'D2' }]),
    });
    expect(second.replayed).toBe(false);
    expect(second.collectionRunId).not.toBe(first.collectionRunId);
  });

  it('rejects an empty records array', async () => {
    const { rawToken } = await newWebhookConnector();
    const [prefix] = rawToken.split('.');
    await expect(
      svc.receiveWebhook({ tokenPrefix: prefix, rawToken, records: [], rawBody: '[]' })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('a webhook connector on a paused connector status is rejected', async () => {
    const { source, connector, rawToken } = await newWebhookConnector();
    await svc.updateConnectorStatus(ctx1, businessId, source.id, connector.id, 'paused');
    const [prefix] = rawToken.split('.');
    await expect(
      svc.receiveWebhook({
        tokenPrefix: prefix, rawToken, records: [{ a: 1 }], rawBody: JSON.stringify([{ a: 1 }]),
      })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('regenerating a token invalidates the old one for future deliveries', async () => {
    const { source, connector, rawToken: oldToken } = await newWebhookConnector();
    await svc.generateConnectorWebhookToken(ctx1, businessId, source.id, connector.id);
    const [oldPrefix] = oldToken.split('.');
    await expect(
      svc.receiveWebhook({
        tokenPrefix: oldPrefix, rawToken: oldToken, records: [{ a: 1 }], rawBody: JSON.stringify([{ a: 1 }]),
      })
    ).rejects.toBeInstanceOf(WebhookAuthenticationError);
  });

  it('cross-business isolation: a webhook-created run is not visible under another business', async () => {
    const { rawToken } = await newWebhookConnector();
    const [prefix] = rawToken.split('.');
    const result = await svc.receiveWebhook({
      tokenPrefix: prefix, rawToken, records: [{ a: 1 }], rawBody: JSON.stringify([{ a: 1 }]),
    });
    await expect(
      svc.getRun(ctx1, '00000000-0000-0000-0000-deadbeef00cc', result.collectionRunId)
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe.skipIf(RUN)('DataAcquisitionService webhook intake (skipped, no DATABASE_URL)', () => {
  it('skips live tests when DATABASE_URL is not set', () => {
    expect(RUN).toBe(false);
  });
});
