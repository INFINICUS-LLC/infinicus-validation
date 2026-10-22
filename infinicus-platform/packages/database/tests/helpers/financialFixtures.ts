/**
 * Fixtures for the financial-facts tests (NEW-BI-01): a tenant + workspace + business per "world", and seeders for completed/open orders, expense claims,
 * purchase receipts, sale-line issue movements and recorded indicators. Rows are written with the ADMIN connection (RLS bypassed) exactly as the production
 * writers (POS, intake, procurement) leave them; the tests then read through the application role. Each world uses its own random ids so suites running in
 * parallel never share or clean one another's rows.
 */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

export interface World { tenantId: string; workspaceId: string; businessId: string }

const uc = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export async function createWorld(admin: Pool, label = 'Fin'): Promise<World> {
  const w: World = { tenantId: randomUUID(), workspaceId: randomUUID(), businessId: randomUUID() };
  await admin.query(`INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,$2,$3,'active','test')`, [w.tenantId, `${label} T`, uc('fint')]);
  await admin.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,$3,$4,'active')`, [w.workspaceId, w.tenantId, `${label} WS`, uc('finw')]);
  await admin.query(`INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,$4,$5,'active')`, [w.businessId, w.tenantId, w.workspaceId, `${label} Biz`, uc('finb')]);
  return w;
}

/** A second business in the same workspace of `w`. */
export async function addBusiness(admin: Pool, w: World): Promise<World> {
  const b = { ...w, businessId: randomUUID() };
  await admin.query(`INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'Fin Sibling',$4,'active')`, [b.businessId, w.tenantId, w.workspaceId, uc('finb')]);
  return b;
}

export class Seeder {
  private item: string | null = null; private warehouse: string | null = null; private employee: string | null = null; private supplier: string | null = null;
  constructor(private readonly admin: Pool, readonly w: World) {}
  private scope(): unknown[] { return [this.w.tenantId, this.w.workspaceId, this.w.businessId]; }

  async order(o: { date: string; currency: string; total: string; status?: string; customerId?: string; lines?: { quantity: string; type?: string; total?: string; productId?: string; fulfilled?: string }[] }): Promise<{ orderId: string; lineIds: string[] }> {
    const orderId = randomUUID();
    await this.admin.query(
      `INSERT INTO platform.orders (id, tenant_id, workspace_id, business_id, order_number, order_date, currency_code, total_amount, operational_status, customer_id)
       VALUES ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10)`, [orderId, ...this.scope(), uc('ORD'), o.date, o.currency, o.total, o.status ?? 'completed', o.customerId ?? null]);
    const lineIds: string[] = [];
    for (const [i, line] of (o.lines ?? []).entries()) {
      const id = randomUUID();
      await this.admin.query(
        `INSERT INTO business_operations.order_line_items (id, tenant_id, workspace_id, business_id, order_id, line_number, item_type, description, quantity, unit_price, line_total, product_id, fulfilled_qty)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'fixture line',$8,1,$9,$10,$11)`, [id, ...this.scope(), orderId, i + 1, line.type ?? 'product', line.quantity, line.total ?? line.quantity, line.productId ?? null, line.fulfilled ?? '0']);
      lineIds.push(id);
    }
    return { orderId, lineIds };
  }

  async customer(name = 'Fixture customer'): Promise<string> {
    const id = randomUUID();
    await this.admin.query(`INSERT INTO platform.customers (id, tenant_id, workspace_id, business_id, display_name) VALUES ($1,$2,$3,$4,$5)`, [id, ...this.scope(), name]);
    return id;
  }

  async product(name: string): Promise<string> {
    const id = randomUUID();
    await this.admin.query(`INSERT INTO platform.products (id, tenant_id, workspace_id, business_id, product_code, name) VALUES ($1,$2,$3,$4,$5,$6)`, [id, ...this.scope(), uc('PRD'), name]);
    return id;
  }

  private async stockRefs(): Promise<{ item: string; warehouse: string }> {
    if (this.item === null) {
      this.item = randomUUID(); this.warehouse = randomUUID();
      await this.admin.query(`INSERT INTO platform.inventory_items (id, tenant_id, workspace_id, business_id, sku, name) VALUES ($1,$2,$3,$4,$5,'Fixture item')`, [this.item, ...this.scope(), uc('SKU')]);
      await this.admin.query(`INSERT INTO platform.warehouses (id, tenant_id, workspace_id, business_id, warehouse_code, name) VALUES ($1,$2,$3,$4,$5,'Fixture WH')`, [this.warehouse, ...this.scope(), uc('WH')]);
    }
    return { item: this.item, warehouse: this.warehouse! };
  }

  /** A stock movement; `ref` links it to a sale line (reference_type 'order_line'). */
  async movement(m: { type: string; quantity: string; unitCost?: string | null; currency?: string | null; orderLineId?: string; receiptId?: string }): Promise<string> {
    const { item, warehouse } = await this.stockRefs();
    const id = randomUUID();
    await this.admin.query(
      `INSERT INTO business_operations.inventory_movements (id, tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id, movement_type, quantity, reference_type, reference_id, unit_cost, unit_cost_currency)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, ...this.scope(), item, warehouse, m.type, m.quantity, m.orderLineId ? 'order_line' : m.receiptId ? 'purchase_receipt' : null, m.orderLineId ?? m.receiptId ?? null, m.unitCost ?? null, m.currency ?? null]);
    return id;
  }

  async expenseClaim(c: { status: string; currency: string; items: { date: string; amount: string; currency?: string | null }[] }): Promise<string> {
    if (this.employee === null) {
      this.employee = randomUUID();
      await this.admin.query(`INSERT INTO platform.employees (id, tenant_id, workspace_id, business_id, employee_code, display_name) VALUES ($1,$2,$3,$4,$5,'Fixture Emp')`, [this.employee, ...this.scope(), uc('EMP')]);
    }
    const id = randomUUID();
    await this.admin.query(
      `INSERT INTO business_operations.expense_claims (id, tenant_id, workspace_id, business_id, employee_id, claim_number, purpose, currency_code, claim_status)
       VALUES ($1,$2,$3,$4,$5,$6,'fixture',$7,$8)`, [id, ...this.scope(), this.employee, uc('CLM'), c.currency, c.status]);
    for (const [i, item] of c.items.entries()) {
      await this.admin.query(
        `INSERT INTO business_operations.expense_items (tenant_id, workspace_id, business_id, expense_claim_id, line_number, expense_date, category, description, amount, currency_code)
         VALUES ($1,$2,$3,$4,$5,$6::date,'supplies','fixture',$7,$8)`, [...this.scope(), id, i + 1, item.date, item.amount, item.currency === undefined ? c.currency : item.currency]);
    }
    return id;
  }

  async receipt(r: { receivedAt: string; currency: string; lines: { quantity: string; unitCost: string | null; currency?: string | null }[] }): Promise<string> {
    if (this.supplier === null) {
      this.supplier = randomUUID();
      await this.admin.query(`INSERT INTO platform.suppliers (id, tenant_id, workspace_id, business_id, name, supplier_code) VALUES ($1,$2,$3,$4,'Fixture Sup',$5)`, [this.supplier, ...this.scope(), uc('SUP')]);
    }
    const { item } = await this.stockRefs();
    const po = randomUUID(); const receipt = randomUUID();
    await this.admin.query(`INSERT INTO business_operations.purchase_orders (id, tenant_id, workspace_id, business_id, supplier_id, po_number, currency_code) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [po, ...this.scope(), this.supplier, uc('PO'), r.currency]);
    await this.admin.query(`INSERT INTO business_operations.purchase_receipts (id, tenant_id, workspace_id, business_id, purchase_order_id, receipt_number, received_at) VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz)`, [receipt, ...this.scope(), po, uc('RCP'), r.receivedAt]);
    for (const [i, line] of r.lines.entries()) {
      const movement = await this.movement({ type: 'receipt', quantity: line.quantity, unitCost: line.unitCost, currency: line.unitCost === null ? null : (line.currency === undefined ? r.currency : line.currency), receiptId: receipt });
      await this.admin.query(
        `INSERT INTO business_operations.purchase_receipt_lines (tenant_id, workspace_id, business_id, purchase_receipt_id, line_number, inventory_item_id, inventory_movement_id, quantity, unit_cost, unit_cost_currency, correlation_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [...this.scope(), receipt, i + 1, item, movement, line.quantity, line.unitCost, line.unitCost === null ? null : (line.currency === undefined ? r.currency : line.currency), randomUUID()]);
    }
    return receipt;
  }

  async indicator(i: { code: string; name?: string; start: string; end: string; value: string; target?: string; variance?: string; category?: string }): Promise<void> {
    await this.admin.query(
      `INSERT INTO business_operations.operational_performance_records (tenant_id, workspace_id, business_id, metric_code, metric_name, metric_category, period_start, period_end, numeric_value, unit, target_value, variance)
       VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz,$8::timestamptz,$9,'%',$10,$11)`, [...this.scope(), i.code, i.name ?? i.code, i.category ?? 'sales', i.start, i.end, i.value, i.target ?? null, i.variance ?? null]);
  }
}
