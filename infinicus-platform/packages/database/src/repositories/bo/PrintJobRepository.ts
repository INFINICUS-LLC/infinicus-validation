import type { TenantContext } from '../../client.js';
import { withTenantTransaction } from '../../client.js';
import { NotFoundError, ConflictError } from './errors.js';
import type { PrinterKind } from './PrinterRepository.js';

export type PrintTrigger = 'automatic' | 'reprint' | 'manual';
export type PrintOutcome = 'succeeded' | 'failed';
export type PrintFailureCode = 'printer_error' | 'timeout' | 'unsupported' | 'other';
export type PrintedVia = 'browser' | 'device';

export interface PrintJob {
  id: string;
  businessId: string;
  orderId: string;
  printerId: string | null;
  kind: PrinterKind;
  trigger: PrintTrigger;
  outcome: PrintOutcome;
  failureCode: PrintFailureCode | null;
  printedVia: PrintedVia;
  createdBy: string | null;
  createdAt: Date;
}

export interface RecordPrintJobInput {
  businessId: string;
  orderId: string;
  kind: PrinterKind;
  trigger: PrintTrigger;
  outcome: PrintOutcome;
  failureCode?: PrintFailureCode;
  printedVia: PrintedVia;
  printerId?: string;
  createdBy?: string;
}

function rowToJob(row: Record<string, unknown>): PrintJob {
  return {
    id: row.id as string,
    businessId: row.business_id as string,
    orderId: row.order_id as string,
    printerId: (row.printer_id as string | null) ?? null,
    kind: row.kind as PrinterKind,
    trigger: row.trigger_kind as PrintTrigger,
    outcome: row.outcome as PrintOutcome,
    failureCode: (row.failure_code as PrintFailureCode | null) ?? null,
    printedVia: row.printed_via as PrintedVia,
    createdBy: (row.created_by as string | null) ?? null,
    createdAt: row.created_at as Date,
  };
}

/**
 * The print-job log (POS-8c, migration 0209): an append-only record of print attempts and how each ended. No content is stored. A receipt is logged only
 * for a completed order; a kitchen ticket for an order that is not failed (voided) - open or completed. The order and any printer must belong to the
 * business (and its tenant/workspace, through row-level security) and a printer must be of the logged kind.
 */
export class PrintJobRepository {
  async record(ctx: TenantContext, input: RecordPrintJobInput): Promise<PrintJob> {
    return withTenantTransaction(ctx, async (client) => {
      const order = await client.query<{ operational_status: string }>(
        `SELECT operational_status FROM platform.orders WHERE id = $1 AND business_id = $2`,
        [input.orderId, input.businessId],
      );
      if (order.rows.length === 0) throw new NotFoundError('Order', input.orderId);
      const status = order.rows[0].operational_status;
      if (input.kind === 'receipt' && status !== 'completed') throw new ConflictError('PrintJob', `a receipt exists only for a completed order (order ${input.orderId} is ${status})`);
      if (input.kind === 'kitchen' && (status === 'failed' || status === 'reversed')) throw new ConflictError('PrintJob', `a kitchen ticket is not printed for a voided order (order ${input.orderId} is ${status})`);
      if (input.printerId) {
        const printer = await client.query<{ kind: string }>(
          `SELECT kind FROM business_operations.printers WHERE id = $1 AND business_id = $2`,
          [input.printerId, input.businessId],
        );
        if (printer.rows.length === 0) throw new NotFoundError('Printer', input.printerId);
        if (printer.rows[0].kind !== input.kind) throw new ConflictError('PrintJob', `printer ${input.printerId} is a ${printer.rows[0].kind} printer, not a ${input.kind} printer`);
      }
      const result = await client.query<Record<string, unknown>>(
        `INSERT INTO business_operations.print_jobs
           (tenant_id, workspace_id, business_id, order_id, printer_id, kind, trigger_kind, outcome, failure_code, printed_via, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`,
        [ctx.tenantId, ctx.workspaceId, input.businessId, input.orderId, input.printerId ?? null, input.kind, input.trigger, input.outcome,
          input.outcome === 'failed' ? (input.failureCode ?? 'other') : null, input.printedVia, input.createdBy ?? null],
      );
      return rowToJob(result.rows[0]);
    });
  }

  /** Newest first. With an order id, that order's attempts; otherwise the business's most recent ones. */
  async list(ctx: TenantContext, businessId: string, options: { orderId?: string; limit?: number } = {}): Promise<PrintJob[]> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    return withTenantTransaction(ctx, async (client) => {
      const result = options.orderId
        ? await client.query<Record<string, unknown>>(
          `SELECT * FROM business_operations.print_jobs WHERE business_id = $1 AND order_id = $2 ORDER BY created_at DESC, id DESC LIMIT $3`,
          [businessId, options.orderId, limit])
        : await client.query<Record<string, unknown>>(
          `SELECT * FROM business_operations.print_jobs WHERE business_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
          [businessId, limit]);
      return result.rows.map(rowToJob);
    });
  }
}
