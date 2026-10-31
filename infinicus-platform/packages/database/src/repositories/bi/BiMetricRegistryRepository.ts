/**
 * BI-09 registry persistence (BI-2-DEV-02). Stores governed metric definitions in the Stage 2D tables (metric_definitions / metric_definition_versions, extended by
 * migration 0222); there is no second registry. The registry RULES (validation, duplicate and cycle rejection, versioning) live in @infinicus/workflow and run
 * inside the transaction this repository opens: `transaction` takes an advisory lock for the business, so two writers cannot both pass a rule against the same
 * registry. Every statement is pinned to the caller's tenant and workspace and to one business. This repository calculates nothing and writes only
 * business_intelligence.metric_definitions and metric_definition_versions.
 */
import { withTenantTransaction, type TenantContext } from '../../client.js';
import { NotFoundError } from './errors.js';

export interface StoredMetricVersion {
  metricId: string;
  versionNumber: number;
  /** The canonical definition content exactly as it was committed. */
  content: Record<string, unknown>;
  contentHash: string;
  /** When the definition was first created and when this version was written. */
  definitionCreatedAt: Date;
  versionCreatedAt: Date;
}

export interface MetricRegistrySnapshot {
  /** Every governed version of every governed definition of the business. */
  versions: StoredMetricVersion[];
  /** Codes of definitions that predate governance (no snapshot). They still own their code. */
  ungovernedCodes: string[];
}

export interface RegistryDatasetRef { id: string; domain: string }

/** The header a governed definition mirrors from its latest version. `status` and `domain` are checked by the table. */
export interface MetricHeaderWrite {
  metricCode: string;
  domain: string;
  metricType: string;
  name: string;
  description: string;
  unit: string;
  currencyCode: string | null;
  status: string;
}

export interface MetricVersionWrite {
  metricId: string;
  versionNumber: number;
  warehouseDatasetId: string;
  content: Record<string, unknown>;
  contentHash: string;
  aggregationMethod: string | null;
  timeGrain: string;
  dimensionalFilters: unknown[];
  calculationSpecification: Record<string, unknown>;
  correlationId: string;
}

/** What the database recorded for a write: the version id and the database-clock timestamps. */
export interface StoredWrite { versionId: string; definitionCreatedAt: Date; versionCreatedAt: Date }

export interface MetricRegistryTx {
  load(): Promise<MetricRegistrySnapshot>;
  /** The business's own dataset (null for another business, workspace or tenant, and for an id that does not exist). */
  resolveDataset(datasetId: string): Promise<RegistryDatasetRef | null>;
  /** Creates the header (new id) and its version 1. */
  insertFirstVersion(header: MetricHeaderWrite, version: MetricVersionWrite): Promise<StoredWrite>;
  /** Adds the next version and refreshes the header. */
  insertNextVersion(header: MetricHeaderWrite, version: MetricVersionWrite): Promise<StoredWrite>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class BiMetricRegistryRepository {
  /**
   * Runs `fn` in one tenant transaction holding the business's registry lock. The business must belong to the caller's workspace, or nothing runs
   * (NotFoundError, the same as a business that does not exist).
   */
  async transaction<T>(ctx: TenantContext, businessId: string, fn: (tx: MetricRegistryTx) => Promise<T>, options: { lock: boolean } = { lock: true }): Promise<T> {
    if (!UUID.test(businessId)) throw new NotFoundError('Business', businessId);
    return withTenantTransaction(ctx, async (client) => {
      const business = await client.query(
        'SELECT 1 FROM platform.businesses WHERE id = $1 AND tenant_id = $2 AND workspace_id = $3 AND deleted_at IS NULL',
        [businessId, ctx.tenantId, ctx.workspaceId]
      );
      if (business.rowCount !== 1) throw new NotFoundError('Business', businessId);
      if (options.lock) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`bi_metric_registry:${businessId}`]);

      const scope = [ctx.tenantId, ctx.workspaceId, businessId];
      const tx: MetricRegistryTx = {
        async load() {
          const versions = await client.query<Record<string, unknown>>(
            `SELECT v.metric_definition_id, v.version_number, v.definition_content, v.content_hash, d.created_at AS definition_created_at, v.created_at AS version_created_at
               FROM business_intelligence.metric_definition_versions v
               JOIN business_intelligence.metric_definitions d ON d.id = v.metric_definition_id
              WHERE v.tenant_id = $1 AND v.workspace_id = $2 AND v.business_id = $3 AND v.definition_content IS NOT NULL
              ORDER BY v.metric_definition_id, v.version_number`,
            scope
          );
          const ungoverned = await client.query<Record<string, unknown>>(
            `SELECT d.metric_code FROM business_intelligence.metric_definitions d
              WHERE d.tenant_id = $1 AND d.workspace_id = $2 AND d.business_id = $3
                AND NOT EXISTS (SELECT 1 FROM business_intelligence.metric_definition_versions v WHERE v.metric_definition_id = d.id AND v.definition_content IS NOT NULL)
              ORDER BY d.metric_code`,
            scope
          );
          return {
            versions: versions.rows.map((r) => ({
              metricId: r.metric_definition_id as string,
              versionNumber: r.version_number as number,
              content: r.definition_content as Record<string, unknown>,
              contentHash: r.content_hash as string,
              definitionCreatedAt: r.definition_created_at as Date,
              versionCreatedAt: r.version_created_at as Date,
            })),
            ungovernedCodes: ungoverned.rows.map((r) => r.metric_code as string),
          };
        },

        async resolveDataset(datasetId) {
          if (!UUID.test(datasetId)) return null;
          const r = await client.query<Record<string, unknown>>(
            'SELECT id, domain FROM business_intelligence.analytical_datasets WHERE id = $1 AND tenant_id = $2 AND workspace_id = $3 AND business_id = $4',
            [datasetId, ...scope]
          );
          return r.rowCount === 1 ? { id: r.rows[0]!.id as string, domain: r.rows[0]!.domain as string } : null;
        },

        async insertFirstVersion(header, version) {
          await client.query(
            `INSERT INTO business_intelligence.metric_definitions
               (id, tenant_id, workspace_id, business_id, metric_code, domain, metric_type, name, description, unit, currency_code, status, latest_version)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,0)`,
            [version.metricId, ...scope, header.metricCode, header.domain, header.metricType, header.name, header.description, header.unit, header.currencyCode, header.status]
          );
          return writeVersion(version);
        },

        async insertNextVersion(header, version) {
          const def = await client.query<Record<string, unknown>>(
            'SELECT latest_version FROM business_intelligence.metric_definitions WHERE id = $1 AND tenant_id = $2 AND workspace_id = $3 AND business_id = $4 FOR UPDATE',
            [version.metricId, ...scope]
          );
          if (def.rowCount !== 1) throw new NotFoundError('MetricDefinition', version.metricId);
          return writeVersion(version, header);
        },
      };

      async function writeVersion(version: MetricVersionWrite, refreshHeader?: MetricHeaderWrite): Promise<StoredWrite> {
        const inserted = await client.query<Record<string, unknown>>(
          `INSERT INTO business_intelligence.metric_definition_versions
             (metric_definition_id, tenant_id, workspace_id, business_id, version_number, aggregation_method, dimensional_filters, time_grain, calculation_specification,
              correlation_id, warehouse_dataset_id, definition_content, content_hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10,$11,$12::jsonb,$13)
           RETURNING id, created_at`,
          [
            version.metricId, ...scope, version.versionNumber, version.aggregationMethod, JSON.stringify(version.dimensionalFilters), version.timeGrain,
            JSON.stringify(version.calculationSpecification), version.correlationId, version.warehouseDatasetId, JSON.stringify(version.content), version.contentHash,
          ]
        );
        if (refreshHeader) {
          await client.query(
            `UPDATE business_intelligence.metric_definitions
                SET domain = $5, metric_type = $6, name = $7, description = $8, unit = $9, currency_code = $10, status = $11, latest_version = $12
              WHERE id = $1 AND tenant_id = $2 AND workspace_id = $3 AND business_id = $4`,
            [version.metricId, ...scope, refreshHeader.domain, refreshHeader.metricType, refreshHeader.name, refreshHeader.description, refreshHeader.unit,
             refreshHeader.currencyCode, refreshHeader.status, version.versionNumber]
          );
        } else {
          await client.query(
            'UPDATE business_intelligence.metric_definitions SET latest_version = $5 WHERE id = $1 AND tenant_id = $2 AND workspace_id = $3 AND business_id = $4',
            [version.metricId, ...scope, version.versionNumber]
          );
        }
        const header = await client.query<Record<string, unknown>>(
          'SELECT created_at FROM business_intelligence.metric_definitions WHERE id = $1 AND tenant_id = $2 AND workspace_id = $3 AND business_id = $4', [version.metricId, ...scope]);
        return { versionId: inserted.rows[0]!.id as string, definitionCreatedAt: header.rows[0]!.created_at as Date, versionCreatedAt: inserted.rows[0]!.created_at as Date };
      }

      return fn(tx);
    });
  }

  /** Read-only view of the governed registry (no lock). */
  async load(ctx: TenantContext, businessId: string): Promise<MetricRegistrySnapshot> {
    return this.transaction(ctx, businessId, (tx) => tx.load(), { lock: false });
  }
}
