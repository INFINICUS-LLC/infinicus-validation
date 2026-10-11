import type { PoolClient } from 'pg';
import type { TenantContext } from '@infinicus/database';
import { OperationalMappingError } from './errors.js';
import { UNIT_COST_MINIMUM_STORABLE, unitCostProblem } from './unitCost.js';
import type { OperationalCommand } from './types.js';

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

export class OperationalCommandExecutor {
  async executeOn(
    client: PoolClient,
    ctx: TenantContext,
    command: OperationalCommand
  ): Promise<CommandExecutionResult> {
    if (
      command.context.tenantId !== ctx.tenantId ||
      command.context.workspaceId !== ctx.workspaceId
    ) {
      throw new OperationalMappingError('Command tenant/workspace scope does not match active context.');
    }

    switch (command.type) {
      case 'record_inventory_movement':
        return this.recordInventoryMovement(client, ctx, command);
      case 'create_purchase_order':
        return this.createPurchaseOrder(client, ctx, command);
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

  private async recordInventoryMovement(
    client: PoolClient,
    ctx: TenantContext,
    command: Extract<OperationalCommand, { type: 'record_inventory_movement' }>
  ): Promise<CommandExecutionResult> {
    const p = command.payload;
    const businessId = command.context.businessId;
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
          movement_type, quantity, reference_type, reference_id, unit_cost, unit_cost_currency, notes, correlation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id`,
      [
        ctx.tenantId, ctx.workspaceId, businessId, p.inventoryItemId, p.warehouseId,
        p.movementType, p.quantity, p.referenceType ?? null, p.referenceId ?? null,
        p.unitCost ?? null, p.unitCostCurrency ?? null, p.notes ?? null, command.context.correlationId,
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

    return { commandType: command.type, recordId: movement.rows[0].id };
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
