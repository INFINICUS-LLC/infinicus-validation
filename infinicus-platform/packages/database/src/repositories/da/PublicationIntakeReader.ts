import type { PoolClient } from 'pg';

/**
 * Data Acquisition's read port for a target layer that is taking delivery of a published package (the DAL -> BO handoff's data path).
 *
 * OWNERSHIP (architecture finding V-07, residual): the handoff payload carries references, so the receiving layer must read the package, its
 * submissions and their provenance to apply them. It used to do that with its own SQL on `data_acquisition.*` tables. Those tables belong to Data
 * Acquisition, so the reads live HERE, behind DAL's own interface; a target layer names no `data_acquisition.` relation at all.
 *
 * Reads only. It writes nothing and decides nothing: the receiving layer keeps its own validation, mapping and persistence. Every method runs on the
 * caller's transaction client (the `...On(client)` convention), so the tenant context, the RLS scope and the row lock taken for the whole intake are
 * unchanged by moving the SQL here: the statements are the ones the receiving layer ran before, byte for byte in meaning.
 */

/** The facts of a publication package a receiving layer re-checks against the handoff. */
export interface PublicationPackageForIntake {
  tenantId: string;
  workspaceId: string;
  businessId: string | null;
  status: string;
  targetLayer: string;
  recordCount: number;
  /** The package's data reference as stored (the receiving layer extracts what it needs, e.g. the collection run). */
  dataReference: unknown;
}

export interface SubmissionForIntake {
  id: string;
  payload: unknown;
}

export interface ProvenanceForIntake {
  id: string;
  recordReference: string;
}

export class PublicationIntakeReader {
  /**
   * Reads one package and LOCKS it (`FOR UPDATE`) for the rest of the caller's transaction, so concurrent intakes of the same package serialize.
   * Returns null when the package is not visible to the caller's tenant (RLS) or does not exist.
   */
  async lockPackageOn(client: PoolClient, publicationPackageId: string): Promise<PublicationPackageForIntake | null> {
    const result = await client.query<Record<string, unknown>>(
      `SELECT tenant_id, workspace_id, business_id, status, target_layer, record_count, data_reference
         FROM data_acquisition.publication_packages
        WHERE id = $1
          FOR UPDATE`,
      [publicationPackageId]
    );
    if (result.rowCount !== 1) return null;
    const row = result.rows[0];
    return {
      tenantId: row.tenant_id as string,
      workspaceId: row.workspace_id as string,
      businessId: (row.business_id as string | null) ?? null,
      status: row.status as string,
      targetLayer: row.target_layer as string,
      recordCount: Number(row.record_count),
      dataReference: row.data_reference,
    };
  }

  /** The manual submissions of a collection run, oldest first. */
  async submissionsForCollectionRunOn(client: PoolClient, collectionRunId: string): Promise<SubmissionForIntake[]> {
    const result = await client.query<{ id: string; payload: unknown }>(
      `SELECT id, payload
         FROM data_acquisition.manual_submissions
        WHERE collection_run_id = $1
        ORDER BY created_at ASC`,
      [collectionRunId]
    );
    return result.rows.map((row) => ({ id: row.id, payload: row.payload }));
  }

  /** The provenance records of a collection run. A submission record without one was rejected by Data Acquisition and is never delivered. */
  async provenanceForCollectionRunOn(client: PoolClient, collectionRunId: string): Promise<ProvenanceForIntake[]> {
    const result = await client.query<{ id: string; record_reference: string }>(
      `SELECT id, record_reference
         FROM data_acquisition.provenance_records
        WHERE collection_run_id = $1`,
      [collectionRunId]
    );
    return result.rows.map((row) => ({ id: row.id, recordReference: row.record_reference }));
  }
}
