import type { PoolClient } from 'pg';
import type { TenantContext } from '@infinicus/database';
import { OperationalMappingError, ReorderBaselineChangedError, ReorderPolicyAlreadyConfiguredError } from './errors.js';
import { canonicalUuidReference, referenceIdProblem } from './uuidReference.js';
import { UNIT_COST_MINIMUM_STORABLE, unitCostProblem } from './unitCost.js';
import { Decimal } from './inventory-policy/decimal.js';
import type { ConfigureInventoryReorderPolicyCommand, OperationalCommand } from './types.js';
import { canonicalJson, canonicalReceiptContent, purchaseReceiptProblems } from './procurement/purchaseReceipt.js';

/** inventory_balances.reorder_point / reorder_quantity are numeric(18,4). */
const REORDER_VALUE_MAX_DECIMALS = 4;
const REORDER_VALUE_EXCLUSIVE_MAX = Decimal.of(10n ** 14n);

export interface CommandExecutionResult {
  commandType: OperationalCommand['type'];
  recordId: string;
}

function inventoryDelta(
  movementType: Extract<OperationalCommand, { type: 'record_inventory_movement' }>['payload']['movementType'],
  quantity: number
): number {
  const magnitude = Math.abs(quantity);
  switch (movementType) {
    case 'receipt':
    case 'transfer_in':
    case 'return':
      return magnitude;
    case 'issue':
    case 'transfer_out':
    case 'write_off':
      return -magnitude;
    case 'adjustment':
    case 'cycle_count':
      return quantity;
  }
}

async function requireBusinessEntity(
  client: PoolClient,
  table: 'suppliers' | 'inventory_items' | 'warehouses' | 'assets',
  entityId: string,
  businessId: string
): Promise<void> {
  const result = await client.query(
    `SELECT id FROM platform.${table} WHERE id = $1 AND business_id = $2`,
    [entityId, businessId]
  );
  if (result.rowCount === 0) {
    throw new OperationalMappingError(`${table} entity not found in business scope: ${entityId}`);
  }
}

/**
 * BO-REF-UUID-01: the movement `referenceId` is stored in a typed uuid column. Returns the lower-case canonical value (or null when absent) and refuses
 * anything else with one deterministic message that does not repeat the value. Called before the first SQL statement of every movement command, so a
 * malformed reference can never reach the database, whichever way the command was built.
 */
function movementReferenceId(referenceId: string | null | undefined): string | null {
  if (referenceId === undefined || referenceId === null) return null;
  const canonical = canonicalUuidReference(referenceId);
  if (canonical === null) throw new OperationalMappingError(referenceIdProblem());
  return canonical;
}

function assertCommandScope(ctx: TenantContext, command: { context: { tenantId: string; workspaceId: string } }): void {
  if (command.context.tenantId !== ctx.tenantId || command.context.workspaceId !== ctx.workspaceId) {
    throw new OperationalMappingError('Command tenant/workspace scope does not match active context.');
  }
}

/** The reorder values of a balance as exact decimal text (never a float). */
export interface ReorderValuesSnapshot {
  reorderPoint: string;
  reorderQuantity: string;
  state: 'UNSET' | 'CONFIGURED';
  version: number;
}

export interface ReorderPolicyConfigurationResult {
  commandType: 'configure_inventory_reorder_policy';
  recordId: string;
  /** False when nothing was written (the balance was already configured with exactly these values). */
  applied: boolean;
  before: ReorderValuesSnapshot;
  /** The balance after the command (equal to `before` when nothing was applied). */
  after: ReorderValuesSnapshot;
}

const exact = (v: unknown): string => Decimal.parse(String(v))?.toString() ?? String(v);

export class OperationalCommandExecutor {
  async executeOn(
    client: PoolClient,
    ctx: TenantContext,
    command: OperationalCommand
  ): Promise<CommandExecutionResult> {
    assertCommandScope(ctx, command);

    switch (command.type) {
      case 'create_inventory_item':
        return this.createInventoryItem(client, ctx, command);
      case 'create_warehouse':
        return this.createWarehouse(client, ctx, command);
      case 'record_keyed_inventory_movement':
        return this.recordKeyedInventoryMovement(client, ctx, command);
      case 'record_inventory_movement':
        return this.recordInventoryMovement(client, ctx, command);
      case 'create_purchase_order':
        return this.createPurchaseOrder(client, ctx, command);
      case 'record_purchase_receipt':
        return this.recordPurchaseReceipt(client, ctx, command);
      case 'record_supplier_performance':
        return this.recordSupplierPerformance(client, ctx, command);
      case 'record_workforce_event':
        return this.recordWorkforceEvent(client, ctx, command);
      case 'record_asset_inspection':
        return this.recordAssetInspection(client, ctx, command);
      case 'record_operational_fact':
        return this.recordOperationalFact(client, ctx, command);
    }
  }

  /**
   * AC-2 (D1): creates the canonical inventory item from a published record. Scope from context, provenance in `source_record_id`, no defaults invented (the
   * unit of measure falls back only to the table's own column default when the record states none). A replay with identical attributes is a no-op; the same SKU
   * with different attributes is REFUSED: changing master data is not an ingestion action.
   */
  private async createInventoryItem(
    client: PoolClient,
    ctx: TenantContext,
    command: Extract<OperationalCommand, { type: 'create_inventory_item' }>
  ): Promise<CommandExecutionResult> {
    assertCommandScope(ctx, command);
    const p = command.payload;
    const businessId = command.context.businessId;
    const existing = await client.query<{ id: string; name: string; unit_of_measure: string }>(
      `SELECT id, name, unit_of_measure FROM platform.inventory_items WHERE business_id = $1 AND sku = $2`, [businessId, p.sku]);
    if ((existing.rowCount ?? 0) > 0) {
      const row = existing.rows[0];
      if (row.name !== p.name || (p.unitOfMeasure !== undefined && row.unit_of_measure !== p.unitOfMeasure)) {
        throw new OperationalMappingError(`Inventory item ${p.sku} already exists with different attributes; master data is not changed by intake.`);
      }
      return { commandType: command.type, recordId: row.id };
    }
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO platform.inventory_items
         (tenant_id, workspace_id, business_id, sku, name, unit_of_measure, source_system, source_record_id, correlation_id, created_by)
       VALUES ($1,$2,$3,$4,$5,coalesce($6,'unit'),'INFINICUS_DA',$7,$8,$9)
       RETURNING id`,
      [ctx.tenantId, ctx.workspaceId, businessId, p.sku, p.name, p.unitOfMeasure ?? null, command.context.sourceReference, command.context.correlationId, ctx.userId]
    );
    return { commandType: command.type, recordId: inserted.rows[0].id };
  }

  /** AC-2 (D1): creates the canonical warehouse from a published record (same rules as {@link createInventoryItem}). */
  private async createWarehouse(
    client: PoolClient,
    ctx: TenantContext,
    command: Extract<OperationalCommand, { type: 'create_warehouse' }>
  ): Promise<CommandExecutionResult> {
    assertCommandScope(ctx, command);
    const p = command.payload;
    const businessId = command.context.businessId;
    const existing = await client.query<{ id: string; name: string }>(
      `SELECT id, name FROM platform.warehouses WHERE business_id = $1 AND warehouse_code = $2`, [businessId, p.warehouseCode]);
    if ((existing.rowCount ?? 0) > 0) {
      if (existing.rows[0].name !== p.name) {
        throw new OperationalMappingError(`Warehouse ${p.warehouseCode} already exists with a different name; master data is not changed by intake.`);
      }
      return { commandType: command.type, recordId: existing.rows[0].id };
    }
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO platform.warehouses
         (tenant_id, workspace_id, business_id, warehouse_code, name, source_system, source_record_id, correlation_id, created_by)
       VALUES ($1,$2,$3,$4,$5,'INFINICUS_DA',$6,$7,$8)
       RETURNING id`,
      [ctx.tenantId, ctx.workspaceId, businessId, p.warehouseCode, p.name, command.context.sourceReference, command.context.correlationId, ctx.userId]
    );
    return { commandType: command.type, recordId: inserted.rows[0].id };
  }

  /**
   * AC-2: resolves a natural-key movement to BO identifiers inside the business scope and hands it to the ONE movement writer. A key that does not resolve,
   * or an id AND a key for the same thing, is refused; `occurredAt` must not be in the future on the database clock.
   */
  private async recordKeyedInventoryMovement(
    client: PoolClient,
    ctx: TenantContext,
    command: Extract<OperationalCommand, { type: 'record_keyed_inventory_movement' }>
  ): Promise<CommandExecutionResult> {
    assertCommandScope(ctx, command);
    const { inventoryItemId, inventoryItemSku, warehouseId, warehouseCode, occurredAt, ...rest } = command.payload;
    const businessId = command.context.businessId;
    movementReferenceId(rest.referenceId); // before the SKU / code lookups: nothing is queried for a command that cannot be applied
    if ((inventoryItemId === undefined) === (inventoryItemSku === undefined)) throw new OperationalMappingError('Exactly one of inventoryItemId and sku identifies the item.');
    if ((warehouseId === undefined) === (warehouseCode === undefined)) throw new OperationalMappingError('Exactly one of warehouseId and warehouseCode identifies the warehouse.');
    let itemId = inventoryItemId;
    if (itemId === undefined) {
      const r = await client.query<{ id: string }>(`SELECT id FROM platform.inventory_items WHERE business_id = $1 AND sku = $2`, [businessId, inventoryItemSku]);
      if (r.rowCount !== 1) throw new OperationalMappingError(`Inventory item with SKU ${inventoryItemSku} not found in business scope.`);
      itemId = r.rows[0].id;
    }
    let whId = warehouseId;
    if (whId === undefined) {
      const r = await client.query<{ id: string }>(`SELECT id FROM platform.warehouses WHERE business_id = $1 AND warehouse_code = $2`, [businessId, warehouseCode]);
      if (r.rowCount !== 1) throw new OperationalMappingError(`Warehouse ${warehouseCode} not found in business scope.`);
      whId = r.rows[0].id;
    }
    if (occurredAt !== undefined) {
      const ok = await client.query<{ ok: boolean }>(`SELECT $1::timestamptz <= now() AS ok`, [occurredAt]);
      if (ok.rows[0].ok !== true) throw new OperationalMappingError('occurredAt must not be in the future.');
    }
    const movementId = await this.applyInventoryMovement(client, ctx,
      { type: 'record_inventory_movement', context: command.context, payload: { ...rest, inventoryItemId: itemId, warehouseId: whId } }, occurredAt);
    return { commandType: command.type, recordId: movementId };
  }

  private async recordInventoryMovement(
    client: PoolClient,
    ctx: TenantContext,
    command: Extract<OperationalCommand, { type: 'record_inventory_movement' }>
  ): Promise<CommandExecutionResult> {
    const movementId = await this.applyInventoryMovement(client, ctx, command);
    return { commandType: command.type, recordId: movementId };
  }

  /**
   * THE one writer of an inventory movement and its balance effect (validation, balance lock, ledger INSERT, balance UPDATE, event). A plain movement and
   * the per-line movements of a purchase receipt (Data-capture Block A) both go through here, so there is no second movement writer. `occurredAt`, when
   * given, is the business instant of the movement (a receipt's `received_at`); otherwise the database default (now) applies, as before.
   */
  private async applyInventoryMovement(
    client: PoolClient,
    ctx: TenantContext,
    command: Extract<OperationalCommand, { type: 'record_inventory_movement' }>,
    occurredAt?: string
  ): Promise<string> {
    const p = command.payload;
    const businessId = command.context.businessId;
    const referenceId = movementReferenceId(p.referenceId);
    // Defence in depth for commands built outside the intake mapper: a cost and its currency are both present or both absent.
    if ((p.unitCost === undefined) !== (p.unitCostCurrency === undefined)) {
      throw new OperationalMappingError('unitCost and unitCostCurrency must be supplied together.');
    }
    // Data-capture Block B (defence in depth): a present cost must be finite, strictly positive and storable; never rounded or coerced.
    if (p.unitCost !== undefined) {
      const problem = unitCostProblem(p.unitCost);
      if (problem === 'not_finite') throw new OperationalMappingError('unitCost must be a finite number.');
      if (problem === 'not_positive') throw new OperationalMappingError('unitCost must be greater than zero.');
      if (problem === 'below_minimum_precision') throw new OperationalMappingError(`unitCost must be at least ${UNIT_COST_MINIMUM_STORABLE} (the smallest storable positive cost).`);
    }
    if (p.unitCostCurrency !== undefined && !/^[A-Z]{3}$/.test(p.unitCostCurrency)) {
      throw new OperationalMappingError('unitCostCurrency must be a three-letter uppercase currency code.');
    }
    await requireBusinessEntity(client, 'inventory_items', p.inventoryItemId, businessId);
    await requireBusinessEntity(client, 'warehouses', p.warehouseId, businessId);

    await client.query(
      `INSERT INTO business_operations.inventory_balances
         (tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id,
          quantity_on_hand, reorder_point, reorder_quantity, correlation_id)
       VALUES ($1,$2,$3,$4,$5,0,0,0,$6)
       ON CONFLICT (inventory_item_id, warehouse_id) DO NOTHING`,
      [ctx.tenantId, ctx.workspaceId, businessId, p.inventoryItemId, p.warehouseId, command.context.correlationId]
    );

    const locked = await client.query<Record<string, unknown>>(
      `SELECT id, quantity_on_hand
       FROM business_operations.inventory_balances
       WHERE business_id = $1 AND inventory_item_id = $2 AND warehouse_id = $3
       FOR UPDATE`,
      [businessId, p.inventoryItemId, p.warehouseId]
    );
    if (locked.rowCount !== 1) throw new OperationalMappingError('Inventory balance could not be locked.');

    const delta = inventoryDelta(p.movementType, p.quantity);
    const nextQuantity = Number(locked.rows[0].quantity_on_hand) + delta;
    if (nextQuantity < 0) {
      throw new OperationalMappingError(
        `Inventory movement would make quantity_on_hand negative (${nextQuantity}).`
      );
    }

    const movement = await client.query<{ id: string }>(
      `INSERT INTO business_operations.inventory_movements
         (tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id,
          movement_type, quantity, reference_type, reference_id, unit_cost, unit_cost_currency, notes, correlation_id, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,coalesce($14::timestamptz, now()))
       RETURNING id`,
      [
        ctx.tenantId, ctx.workspaceId, businessId, p.inventoryItemId, p.warehouseId,
        p.movementType, p.quantity, p.referenceType ?? null, referenceId,
        p.unitCost ?? null, p.unitCostCurrency ?? null, p.notes ?? null, command.context.correlationId, occurredAt ?? null,
      ]
    );

    await client.query(
      `UPDATE business_operations.inventory_balances
       SET quantity_on_hand = $2, last_movement_at = now(), version = version + 1
       WHERE id = $1`,
      [locked.rows[0].id, nextQuantity]
    );

    await client.query(
      `SELECT business_operations.emit_inventory_movement_recorded(
         $1,$2,$3,$4,$5,$6,$7,$8
       )`,
      [
        ctx.tenantId, ctx.workspaceId, movement.rows[0].id, p.inventoryItemId,
        p.movementType, p.quantity, command.context.correlationId,
        command.context.causationId ?? null,
      ]
    );

    return movement.rows[0].id;
  }

  /**
   * Data-capture Block A: records a purchase receipt - the header, its lines and the `receipt` inventory movement of each line - in the caller's ONE
   * transaction. The movement ledger stays the one source for stock and cost: the receipt keeps no balance of its own. The receipt number is the business
   * identity of the receipt: replaying EXACTLY the same content is a safe no-op (no second movement, no second line), replaying different content under
   * the same number is refused, and a different number is a different receipt. Fails closed without provenance. Does not touch the purchase order, its
   * lines or any reorder policy (purchase-order linkage and status are Data-capture Block D; reorder policy is a separate BO command).
   */
  private async recordPurchaseReceipt(
    client: PoolClient,
    ctx: TenantContext,
    command: Extract<OperationalCommand, { type: 'record_purchase_receipt' }>
  ): Promise<CommandExecutionResult> {
    const p = command.payload;
    const c = command.context;
    const businessId = c.businessId;
    for (const [name, value] of [['sourceReference', c.sourceReference], ['provenanceReference', c.provenanceReference], ['idempotencyKey', c.idempotencyKey]] as const) {
      if (typeof value !== 'string' || value.trim().length === 0) throw new OperationalMappingError(`A purchase receipt requires ${name} (provenance is never fabricated).`);
    }
    const problems = purchaseReceiptProblems(p); // the SAME rule set as the intake mapper
    if (problems.length > 0) throw new OperationalMappingError(`Invalid purchase receipt: ${problems.join(', ')}`);

    // Scope: every referenced entity must be in THIS business (tenant and workspace are the transaction's, enforced again by row-level security).
    const po = await client.query<{ id: string }>(
      `SELECT id FROM business_operations.purchase_orders WHERE id = $1 AND business_id = $2 AND tenant_id = $3 AND workspace_id = $4`,
      [p.purchaseOrderId, businessId, ctx.tenantId, ctx.workspaceId]
    );
    if (po.rowCount !== 1) throw new OperationalMappingError(`purchase_orders entity not found in business scope: ${p.purchaseOrderId}`);
    await requireBusinessEntity(client, 'warehouses', p.warehouseId, businessId);
    for (const itemId of new Set(p.lines.map((l) => l.inventoryItemId))) await requireBusinessEntity(client, 'inventory_items', itemId, businessId);
    for (const lineId of new Set(p.lines.map((l) => l.purchaseOrderLineId).filter((id): id is string => id !== undefined))) {
      const line = await client.query<{ inventory_item_id: string | null }>(
        `SELECT inventory_item_id FROM business_operations.purchase_order_line_items WHERE id = $1 AND purchase_order_id = $2 AND business_id = $3 AND tenant_id = $4 AND workspace_id = $5`,
        [lineId, p.purchaseOrderId, businessId, ctx.tenantId, ctx.workspaceId]
      );
      if (line.rowCount !== 1) throw new OperationalMappingError(`purchase_order_line_items entity is not a line of this purchase order in business scope: ${lineId}`);
      // Data-capture Block D: when the purchase-order line carries an inventory item, every receipt line against it must record that same item
      // (the database enforces the same rule; this names the problem early). A line without an item link is accepted as before - never inferred or written back.
      const linkedItem = line.rows[0].inventory_item_id;
      if (linkedItem !== null && p.lines.some((l) => l.purchaseOrderLineId === lineId && l.inventoryItemId !== linkedItem)) {
        throw new OperationalMappingError(`receipt line records a different inventory item than purchase-order line ${lineId}`);
      }
    }
    const clock = await client.query<{ future: boolean }>(`SELECT $1::timestamptz > clock_timestamp() AS future`, [p.receivedAt]);
    if (clock.rows[0].future) throw new OperationalMappingError('receivedAt is in the future; a receipt records goods that have already been received.');

    // Serialize concurrent writers of the same receipt number, then decide: create, safe replay, or conflict.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`purchase_receipt:${businessId}:${p.receiptNumber}`]);
    const content = canonicalReceiptContent(p);
    const existing = await client.query<{ id: string; payload: { content?: unknown } }>(
      `SELECT id, payload FROM business_operations.purchase_receipts WHERE business_id = $1 AND receipt_number = $2`,
      [businessId, p.receiptNumber]
    );
    if (existing.rowCount === 1) {
      if (canonicalJson(existing.rows[0].payload?.content) !== canonicalJson(content)) {
        throw new OperationalMappingError(`Purchase receipt ${p.receiptNumber} already exists with different content; a conflicting replay is refused and nothing was changed.`);
      }
      return { commandType: command.type, recordId: existing.rows[0].id }; // the exact same receipt: nothing is written twice
    }

    const header = await client.query<{ id: string }>(
      `INSERT INTO business_operations.purchase_receipts
         (tenant_id, workspace_id, business_id, purchase_order_id, receipt_number, received_at, warehouse_id, notes, payload, correlation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
       RETURNING id`,
      [
        ctx.tenantId, ctx.workspaceId, businessId, p.purchaseOrderId, p.receiptNumber, content.receivedAt, p.warehouseId, p.notes ?? null,
        JSON.stringify({
          content,
          provenance: { sourceReference: c.sourceReference, provenanceReference: c.provenanceReference, idempotencyKey: c.idempotencyKey, actorId: c.actorId, occurredAt: c.occurredAt },
        }),
        c.correlationId,
      ]
    );
    const receiptId = header.rows[0].id;

    for (let i = 0; i < p.lines.length; i++) {
      const line = p.lines[i];
      const movementId = await this.applyInventoryMovement(client, ctx, {
        type: 'record_inventory_movement',
        context: c,
        payload: {
          inventoryItemId: line.inventoryItemId,
          warehouseId: p.warehouseId,
          movementType: 'receipt',
          quantity: line.quantity,
          ...(line.unitCost !== undefined ? { unitCost: line.unitCost, unitCostCurrency: line.unitCostCurrency } : {}),
          referenceType: 'purchase_receipt',
          referenceId: receiptId,
        },
      }, content.receivedAt);
      await client.query(
        `INSERT INTO business_operations.purchase_receipt_lines
           (tenant_id, workspace_id, business_id, purchase_receipt_id, line_number, purchase_order_line_id, inventory_item_id, inventory_movement_id,
            quantity, unit_cost, unit_cost_currency, correlation_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          ctx.tenantId, ctx.workspaceId, businessId, receiptId, i + 1, line.purchaseOrderLineId ?? null, line.inventoryItemId, movementId,
          line.quantity, line.unitCost ?? null, line.unitCostCurrency ?? null, c.correlationId,
        ]
      );
    }
    return { commandType: command.type, recordId: receiptId };
  }

  /**
   * Data-capture Block E: the single writer of `reorder_policy_state`. Marks an existing balance CONFIGURED with the given reorder values,
   * the database time and the source. Not reachable from intake (its command is outside `OperationalCommand`). Values must be finite, non-negative and storable (numeric(18,4)) without rounding. Re-sending the
   * values a balance is already configured with is a no-op: no UPDATE, no version bump. Nothing here backfills or repairs history.
   */
  async configureInventoryReorderPolicy(
    client: PoolClient,
    ctx: TenantContext,
    command: ConfigureInventoryReorderPolicyCommand
  ): Promise<ReorderPolicyConfigurationResult> {
    assertCommandScope(ctx, command);
    const p = command.payload;
    const businessId = command.context.businessId;
    const source = p.configurationSource ?? 'BO_COMMAND';
    if (source !== 'BO_COMMAND' && source !== 'AUTHORIZED_ACTION_PACKAGE') {
      throw new OperationalMappingError('configurationSource must be BO_COMMAND or AUTHORIZED_ACTION_PACKAGE.');
    }
    for (const [name, value] of [['reorderPoint', p.reorderPoint], ['reorderQuantity', p.reorderQuantity]] as const) {
      const d = Decimal.fromNumber(value);
      if (d === null) throw new OperationalMappingError(`${name} must be a finite number.`);
      if (d.isNegative()) throw new OperationalMappingError(`${name} must not be negative.`);
      if (d.scale > REORDER_VALUE_MAX_DECIMALS) throw new OperationalMappingError(`${name} must have at most ${REORDER_VALUE_MAX_DECIMALS} decimal places (it is never rounded).`);
      if (d.gte(REORDER_VALUE_EXCLUSIVE_MAX)) throw new OperationalMappingError(`${name} exceeds the storable range.`);
    }
    await requireBusinessEntity(client, 'inventory_items', p.inventoryItemId, businessId);
    await requireBusinessEntity(client, 'warehouses', p.warehouseId, businessId);

    const locked = await client.query<{ id: string; reorder_point: string; reorder_quantity: string; reorder_policy_state: 'UNSET' | 'CONFIGURED'; version: number }>(
      `SELECT id, reorder_point, reorder_quantity, reorder_policy_state, version
       FROM business_operations.inventory_balances
       WHERE business_id = $1 AND inventory_item_id = $2 AND warehouse_id = $3
       FOR UPDATE`,
      [businessId, p.inventoryItemId, p.warehouseId]
    );
    if (locked.rowCount !== 1) throw new OperationalMappingError('No inventory balance exists for this item and warehouse; a reorder policy cannot be configured without one.');
    const row = locked.rows[0];
    const before: ReorderValuesSnapshot = { reorderPoint: exact(row.reorder_point), reorderQuantity: exact(row.reorder_quantity), state: row.reorder_policy_state, version: Number(row.version) };

    if (p.requireState === 'UNSET' && row.reorder_policy_state !== 'UNSET') throw new ReorderPolicyAlreadyConfiguredError();

    if (p.expectedBaseline !== undefined) {
      const bp = Decimal.fromNumber(p.expectedBaseline.reorderPoint);
      const bq = Decimal.fromNumber(p.expectedBaseline.reorderQuantity);
      if (bp === null || bq === null || bp.cmp(Decimal.parse(before.reorderPoint) as Decimal) !== 0 || bq.cmp(Decimal.parse(before.reorderQuantity) as Decimal) !== 0) {
        throw new ReorderBaselineChangedError();
      }
    }

    const unchanged = row.reorder_policy_state === 'CONFIGURED'
      && Decimal.parse(before.reorderPoint)?.cmp(Decimal.fromNumber(p.reorderPoint) as Decimal) === 0
      && Decimal.parse(before.reorderQuantity)?.cmp(Decimal.fromNumber(p.reorderQuantity) as Decimal) === 0;
    if (unchanged) return { commandType: 'configure_inventory_reorder_policy', recordId: row.id, applied: false, before, after: before };

    // The protected mutation boundary (migration 0196): the database function re-verifies scope and values and writes once under the row lock.
    // Setting a session variable is no longer sufficient to change these fields; only this governed entry point can.
    const updated = await client.query<{ out_applied: boolean; out_reorder_point: string; out_reorder_quantity: string; out_reorder_policy_state: 'UNSET' | 'CONFIGURED'; out_version: number }>(
      `SELECT out_applied, out_reorder_point, out_reorder_quantity, out_reorder_policy_state, out_version
         FROM business_operations.apply_inventory_reorder_policy($1,$2,$3,$4,$5::numeric,$6::numeric,$7,$8::numeric,$9::numeric)`,
      [ctx.tenantId, ctx.workspaceId, businessId, row.id, p.reorderPoint, p.reorderQuantity, source, before.reorderPoint, before.reorderQuantity]
    );
    if (updated.rowCount !== 1) throw new ReorderBaselineChangedError(); // second line of defence behind the row lock
    const u = updated.rows[0];
    const after: ReorderValuesSnapshot = { reorderPoint: exact(u.out_reorder_point), reorderQuantity: exact(u.out_reorder_quantity), state: u.out_reorder_policy_state, version: Number(u.out_version) };
    return { commandType: 'configure_inventory_reorder_policy', recordId: row.id, applied: u.out_applied, before, after };
  }

  private async createPurchaseOrder(
    client: PoolClient,
    ctx: TenantContext,
    command: Extract<OperationalCommand, { type: 'create_purchase_order' }>
  ): Promise<CommandExecutionResult> {
    const p = command.payload;
    const businessId = command.context.businessId;
    // No default currency: a purchase order states its currency explicitly (the database default was removed in 0183).
    if (typeof p.currencyCode !== 'string' || !/^[A-Z]{3}$/.test(p.currencyCode)) {
      throw new OperationalMappingError('currencyCode is required and must be a three-letter uppercase currency code.');
    }
    await requireBusinessEntity(client, 'suppliers', p.supplierId, businessId);

    const result = await client.query<{ id: string }>(
      `INSERT INTO business_operations.purchase_orders
         (tenant_id, workspace_id, business_id, supplier_id, po_number,
          expected_date, currency_code, total_amount, notes, source_system,
          source_record_id, correlation_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'INFINICUS_DA',$10,$11,$12)
       RETURNING id`,
      [
        ctx.tenantId, ctx.workspaceId, businessId, p.supplierId, p.poNumber,
        p.expectedDate ?? null, p.currencyCode, p.totalAmount ?? 0,
        p.notes ?? null, command.context.sourceReference,
        command.context.correlationId, ctx.userId,
      ]
    );
    return { commandType: command.type, recordId: result.rows[0].id };
  }

  private async recordSupplierPerformance(
    client: PoolClient,
    ctx: TenantContext,
    command: Extract<OperationalCommand, { type: 'record_supplier_performance' }>
  ): Promise<CommandExecutionResult> {
    const p = command.payload;
    const businessId = command.context.businessId;
    await requireBusinessEntity(client, 'suppliers', p.supplierId, businessId);
    const result = await client.query<{ id: string }>(
      `INSERT INTO business_operations.supplier_performance_scores
         (tenant_id, workspace_id, business_id, supplier_id, period_start, period_end,
          quality_score, delivery_score, price_score, service_score, overall_score,
          notes, correlation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id`,
      [
        ctx.tenantId, ctx.workspaceId, businessId, p.supplierId,
        p.periodStart, p.periodEnd, p.qualityScore, p.deliveryScore,
        p.priceScore, p.serviceScore, p.overallScore, p.notes ?? null,
        command.context.correlationId,
      ]
    );
    return { commandType: command.type, recordId: result.rows[0].id };
  }

  private async recordWorkforceEvent(
    client: PoolClient,
    ctx: TenantContext,
    command: Extract<OperationalCommand, { type: 'record_workforce_event' }>
  ): Promise<CommandExecutionResult> {
    const p = command.payload;
    const result = await client.query<{ id: string }>(
      `INSERT INTO business_operations.business_events
         (tenant_id, workspace_id, business_id, event_type, quantity, member_id,
          action, notes, correlation_id)
       VALUES ($1,$2,$3,'team',$4,$5,$6,$7,$8)
       RETURNING id`,
      [
        ctx.tenantId, ctx.workspaceId, command.context.businessId,
        p.hours ?? null, p.memberId ?? null, p.action ?? null, p.notes ?? null,
        command.context.correlationId,
      ]
    );
    return { commandType: command.type, recordId: result.rows[0].id };
  }

  private async recordAssetInspection(
    client: PoolClient,
    ctx: TenantContext,
    command: Extract<OperationalCommand, { type: 'record_asset_inspection' }>
  ): Promise<CommandExecutionResult> {
    const p = command.payload;
    const businessId = command.context.businessId;
    await requireBusinessEntity(client, 'assets', p.assetId, businessId);
    const result = await client.query<{ id: string }>(
      `INSERT INTO business_operations.asset_inspections
         (tenant_id, workspace_id, business_id, asset_id, inspection_type,
          condition_rating, pass_fail, findings, actions_required,
          next_inspection_date, correlation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id`,
      [
        ctx.tenantId, ctx.workspaceId, businessId, p.assetId,
        p.inspectionType ?? 'routine', p.conditionRating, p.pass,
        p.findings ?? null, p.actionsRequired ?? null,
        p.nextInspectionDate ?? null, command.context.correlationId,
      ]
    );
    return { commandType: command.type, recordId: result.rows[0].id };
  }

  private async recordOperationalFact(
    client: PoolClient,
    ctx: TenantContext,
    command: Extract<OperationalCommand, { type: 'record_operational_fact' }>
  ): Promise<CommandExecutionResult> {
    const p = command.payload;
    const result = await client.query<{ id: string }>(
      `INSERT INTO business_operations.business_events
         (tenant_id, workspace_id, business_id, event_type, amount, quantity,
          category, customer_id, member_id, action, notes, correlation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id`,
      [
        ctx.tenantId, ctx.workspaceId, command.context.businessId, p.eventType,
        p.amount ?? null, p.quantity ?? null, p.category ?? null,
        p.customerId ?? null, p.memberId ?? null, p.action ?? null,
        p.notes ?? null, command.context.correlationId,
      ]
    );
    return { commandType: command.type, recordId: result.rows[0].id };
  }
}
