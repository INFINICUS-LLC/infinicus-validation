import type { PoolClient } from 'pg';
import type { TenantContext } from '../../client.js';
import { withTenantTransaction } from '../../client.js';
import { NotFoundError } from './errors.js';

/**
 * Data Acquisition's record of delivering a publication package to a destination layer (`data_acquisition.publication_deliveries`, DA-24).
 *
 * OWNERSHIP (architecture violation V-07 / SOT-09, reconciliation item P1-F): the table belongs to Data Acquisition, so every state transition of a
 * delivery is decided HERE, by the source layer. A target layer (Business Operations) does not write the table; it asks for the transition through
 * this repository when it acknowledges or rejects a handoff (docs/architecture/layer-handoff-contracts.md, acknowledgement and rejection). The
 * target keeps owning its own validation, acceptance reason and local persistence.
 *
 * Rules owned here:
 *  - `delivered` is terminal for a package toward a layer: it is never restarted, never counted again and never turned into a failure.
 *  - a new attempt increments `attempt_count`, stamps `last_attempt_at` and clears the previous failure reason.
 *  - a failed attempt records a bounded reason and increments `attempt_count`.
 *
 * TENANT SAFETY: `publication_deliveries` has no tenant column and (today) no row-level security of its own; the 0021 migration treats it as "attached
 * to publication_packages". Direct access would therefore cross tenants. Every statement here reaches a delivery only THROUGH its RLS-protected package
 * (a join / EXISTS on `publication_packages`), so a tenant can neither read, change nor create a delivery for a package it cannot see. Closing the gap in
 * the database itself (row-level security on this and the other child tables) is a separate migration block; this is the defence in depth.
 *
 * The `...On(client)` methods do not open or control a transaction (same convention as PublicationPackageRepository.createOn): callers compose them
 * inside one outer withTenantTransaction().
 */

export type PublicationDeliveryStatus = 'pending' | 'in_progress' | 'delivered' | 'failed' | 'cancelled';

export interface LayerDelivery {
  id: string;
  publicationPackageId: string;
  destinationReference: string;
  status: PublicationDeliveryStatus;
  attemptCount: number;
  lastAttemptAt: Date | null;
  deliveredAt: Date | null;
  failureReason: string | null;
}

export interface LayerAttempt {
  deliveryId: string;
  /** True when the package was already delivered to this layer: nothing was written and the caller must treat the handoff as an idempotent replay. */
  alreadyDelivered: boolean;
}

const LAYER_DESTINATION = 'layer';
const MAX_FAILURE_REASON_LENGTH = 500;

function rowToDelivery(row: Record<string, unknown>): LayerDelivery {
  return {
    id: row.id as string,
    publicationPackageId: row.publication_package_id as string,
    destinationReference: row.destination_reference as string,
    status: row.delivery_status as PublicationDeliveryStatus,
    attemptCount: row.attempt_count as number,
    lastAttemptAt: row.last_attempt_at as Date | null,
    deliveredAt: row.delivered_at as Date | null,
    failureReason: row.failure_reason as string | null,
  };
}

export class PublicationDeliveryRepository {
  /** The delivery of a package toward a layer, or null when none has been recorded. */
  async findLayerDeliveryOn(client: PoolClient, publicationPackageId: string, layer: string): Promise<LayerDelivery | null> {
    const result = await client.query<Record<string, unknown>>(
      `SELECT d.*
       FROM data_acquisition.publication_deliveries d
       JOIN data_acquisition.publication_packages p ON p.id = d.publication_package_id
       WHERE d.publication_package_id = $1
         AND d.destination_type = '${LAYER_DESTINATION}'
         AND d.destination_reference = $2
       ORDER BY d.created_at ASC
       LIMIT 1`,
      [publicationPackageId, layer]
    );
    return result.rowCount === 1 ? rowToDelivery(result.rows[0]) : null;
  }

  /**
   * Begin (or restart) a delivery attempt of a package toward a layer. Creates the delivery on the first attempt. A package that was already
   * delivered is left untouched and reported as such.
   */
  async beginLayerAttemptOn(client: PoolClient, publicationPackageId: string, layer: string): Promise<LayerAttempt> {
    const existing = await this.findLayerDeliveryOn(client, publicationPackageId, layer);
    if (existing !== null && existing.status === 'delivered') {
      return { deliveryId: existing.id, alreadyDelivered: true };
    }
    if (existing !== null) {
      await client.query(
        `UPDATE data_acquisition.publication_deliveries d
         SET delivery_status = 'in_progress',
             attempt_count = d.attempt_count + 1,
             last_attempt_at = now(),
             failure_reason = NULL
         WHERE d.id = $1
           AND EXISTS (SELECT 1 FROM data_acquisition.publication_packages p WHERE p.id = d.publication_package_id)`,
        [existing.id]
      );
      return { deliveryId: existing.id, alreadyDelivered: false };
    }
    // Created only for a package the caller can see (row-level security on the package), never for another tenant's package id.
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO data_acquisition.publication_deliveries
         (publication_package_id, destination_type, destination_reference,
          delivery_status, attempt_count, last_attempt_at)
       SELECT p.id, '${LAYER_DESTINATION}', $2, 'in_progress', 1, now()
       FROM data_acquisition.publication_packages p
       WHERE p.id = $1
       RETURNING id`,
      [publicationPackageId, layer]
    );
    if (inserted.rowCount !== 1) throw new NotFoundError('Publication package', publicationPackageId);
    return { deliveryId: inserted.rows[0].id, alreadyDelivered: false };
  }

  /** The destination layer accepted custody of the package: the delivery is complete (terminal). */
  async markLayerDeliveredOn(client: PoolClient, deliveryId: string): Promise<void> {
    await client.query(
      `UPDATE data_acquisition.publication_deliveries d
       SET delivery_status = 'delivered', delivered_at = now(), failure_reason = NULL
       WHERE d.id = $1
         AND EXISTS (SELECT 1 FROM data_acquisition.publication_packages p WHERE p.id = d.publication_package_id)`,
      [deliveryId]
    );
  }

  /**
   * The destination layer rejected the handoff or its processing failed. Runs in its OWN transaction so the failure is recorded even though the
   * target's processing transaction was rolled back. A package that was already delivered is never turned into a failure. An unknown package is
   * ignored (nothing to attach the record to).
   */
  async recordLayerFailure(ctx: TenantContext, publicationPackageId: string, layer: string, reason: string): Promise<void> {
    const bounded = reason.slice(0, MAX_FAILURE_REASON_LENGTH);
    await withTenantTransaction(ctx, async (client) => {
      // Lock the package row only to serialize delivery creation; the package itself is not modified.
      const pkg = await client.query(
        `SELECT id FROM data_acquisition.publication_packages WHERE id = $1 FOR UPDATE`,
        [publicationPackageId]
      );
      if (pkg.rowCount !== 1) return;

      const existing = await client.query<Record<string, unknown>>(
        `SELECT id, delivery_status
         FROM data_acquisition.publication_deliveries
         WHERE publication_package_id = $1
           AND destination_type = '${LAYER_DESTINATION}'
           AND destination_reference = $2
         ORDER BY created_at ASC
         LIMIT 1
         FOR UPDATE`,
        [publicationPackageId, layer]
      );

      if (existing.rowCount === 1 && existing.rows[0].delivery_status === 'delivered') return;

      if (existing.rowCount === 1) {
        await client.query(
          `UPDATE data_acquisition.publication_deliveries
           SET delivery_status = 'failed',
               attempt_count = attempt_count + 1,
               last_attempt_at = now(),
               failure_reason = $2
           WHERE id = $1`,
          [existing.rows[0].id, bounded]
        );
        return;
      }

      await client.query(
        `INSERT INTO data_acquisition.publication_deliveries
           (publication_package_id, destination_type, destination_reference,
            delivery_status, attempt_count, last_attempt_at, failure_reason)
         VALUES ($1,'${LAYER_DESTINATION}',$2,'failed',1,now(),$3)`,
        [publicationPackageId, layer, bounded]
      );
    });
  }
}
