import type { TenantContext } from '../../client.js';
import { withTenantTransaction } from '../../client.js';
import { NotFoundError, ConflictError } from './errors.js';

export type PrinterKind = 'receipt' | 'kitchen';
export type PrinterConnection = 'browser' | 'network' | 'bluetooth' | 'usb';
export type PaperWidth = 58 | 80;

export interface Printer {
  id: string;
  businessId: string;
  name: string;
  kind: PrinterKind;
  connection: PrinterConnection;
  paperMm: PaperWidth;
  isDefault: boolean;
  status: 'active' | 'retired';
  createdBy: string | null;
  retiredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreatePrinterInput {
  businessId: string;
  name: string;
  kind: PrinterKind;
  connection: PrinterConnection;
  paperMm: PaperWidth;
  /** Make this the default printer of its kind. The first active printer of a kind is the default regardless. */
  isDefault?: boolean;
  createdBy?: string;
}

function rowToPrinter(row: Record<string, unknown>): Printer {
  return {
    id: row.id as string,
    businessId: row.business_id as string,
    name: row.name as string,
    kind: row.kind as PrinterKind,
    connection: row.connection as PrinterConnection,
    paperMm: Number(row.paper_mm) as PaperWidth,
    isDefault: row.is_default as boolean,
    status: row.status as 'active' | 'retired',
    createdBy: (row.created_by as string | null) ?? null,
    retiredAt: (row.retired_at as Date | null) ?? null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

const UNIQUE_VIOLATION = '23505';

/**
 * The printers a business has declared (POS-8b, migration 0208). It records THAT a printer exists and how it is used; the physical address of a printer
 * (network, Bluetooth, USB) is kept by the device shell on the device, never here. Printers are retired, not deleted. At most one active default per
 * business and kind, enforced by the database as well as here.
 */
export class PrinterRepository {
  async create(ctx: TenantContext, input: CreatePrinterInput): Promise<Printer> {
    return withTenantTransaction(ctx, async (client) => {
      const sameKind = await client.query(
        `SELECT 1 FROM business_operations.printers WHERE business_id = $1 AND kind = $2 AND status = 'active' AND is_default LIMIT 1`,
        [input.businessId, input.kind],
      );
      const makeDefault = input.isDefault === true || sameKind.rows.length === 0;
      try {
        if (makeDefault) {
          await client.query(
            `UPDATE business_operations.printers SET is_default = false WHERE business_id = $1 AND kind = $2 AND is_default`,
            [input.businessId, input.kind],
          );
        }
        const result = await client.query<Record<string, unknown>>(
          `INSERT INTO business_operations.printers (tenant_id, workspace_id, business_id, name, kind, connection, paper_mm, is_default, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           RETURNING *`,
          [ctx.tenantId, ctx.workspaceId, input.businessId, input.name, input.kind, input.connection, input.paperMm, makeDefault, input.createdBy ?? null],
        );
        return rowToPrinter(result.rows[0]);
      } catch (e) {
        const err = e as { code?: string; constraint?: string };
        if (err.code === UNIQUE_VIOLATION) {
          throw new ConflictError('Printer', err.constraint === 'idx_printers_one_default_per_business_kind'
            ? `another default ${input.kind} printer was set at the same moment for business ${input.businessId}; try again`
            : `a printer named "${input.name}" already exists for business ${input.businessId}`);
        }
        throw e;
      }
    });
  }

  /** Active printers first (defaults first), then retired ones; oldest first within each. */
  async list(ctx: TenantContext, businessId: string): Promise<Printer[]> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT * FROM business_operations.printers WHERE business_id = $1
         ORDER BY (status = 'active') DESC, kind, is_default DESC, created_at, id`,
        [businessId],
      );
      return result.rows.map(rowToPrinter);
    });
  }

  /** The printers print jobs are routed to: the active default of each kind, or null when the business has none (the browser's own print path is then used). */
  async routes(ctx: TenantContext, businessId: string): Promise<{ receipt: Printer | null; kitchen: Printer | null }> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT * FROM business_operations.printers WHERE business_id = $1 AND status = 'active' AND is_default`,
        [businessId],
      );
      const printers = result.rows.map(rowToPrinter);
      return { receipt: printers.find((p) => p.kind === 'receipt') ?? null, kitchen: printers.find((p) => p.kind === 'kitchen') ?? null };
    });
  }

  /** Makes an active printer the default of its kind; the previous default stops being one in the same transaction. Already the default = no change. */
  async setDefault(ctx: TenantContext, businessId: string, printerId: string): Promise<Printer> {
    return withTenantTransaction(ctx, async (client) => {
      const found = await client.query<Record<string, unknown>>(
        `SELECT * FROM business_operations.printers WHERE id = $1 AND business_id = $2 FOR UPDATE`,
        [printerId, businessId],
      );
      if (found.rows.length === 0) throw new NotFoundError('Printer', printerId);
      const printer = rowToPrinter(found.rows[0]);
      if (printer.status !== 'active') throw new ConflictError('Printer', `printer ${printerId} is retired and cannot be the default`);
      if (printer.isDefault) return printer;
      await client.query(
        `UPDATE business_operations.printers SET is_default = false WHERE business_id = $1 AND kind = $2 AND is_default`,
        [businessId, printer.kind],
      );
      const result = await client.query<Record<string, unknown>>(
        `UPDATE business_operations.printers SET is_default = true WHERE id = $1 RETURNING *`,
        [printerId],
      );
      return rowToPrinter(result.rows[0]);
    });
  }

  /** Retires a printer (it is kept for history). A retired printer is never the default; retiring a retired printer is a no-op. */
  async retire(ctx: TenantContext, businessId: string, printerId: string): Promise<Printer> {
    return withTenantTransaction(ctx, async (client) => {
      const found = await client.query<Record<string, unknown>>(
        `SELECT * FROM business_operations.printers WHERE id = $1 AND business_id = $2 FOR UPDATE`,
        [printerId, businessId],
      );
      if (found.rows.length === 0) throw new NotFoundError('Printer', printerId);
      if ((found.rows[0].status as string) === 'retired') return rowToPrinter(found.rows[0]);
      const result = await client.query<Record<string, unknown>>(
        `UPDATE business_operations.printers SET status = 'retired', is_default = false, retired_at = now() WHERE id = $1 RETURNING *`,
        [printerId],
      );
      return rowToPrinter(result.rows[0]);
    });
  }
}
