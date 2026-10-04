/**
 * Integration tests for Stage 2C Business Operations repositories.
 *
 * Requires:
 *   DATABASE_URL       — app_test_user (RLS enforced)
 *   ADMIN_DATABASE_URL — infinicus_test_admin (BYPASSRLS)
 *
 * Guard pattern: describe.runIf(!!process.env.DATABASE_URL)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { createPool, closePool } from '../src/client.js';
import {
  LeadRepository,
  OpportunityRepository,
  PurchaseOrderRepository,
  SupportCaseRepository,
  IncidentRepository,
  TaskRepository,
  InventoryBalanceRepository,
  BusinessEventRepository,
} from '../src/repositories/bo/index.js';
import { NotFoundError } from '../src/repositories/bo/errors.js';

const run = !!process.env.DATABASE_URL;

// ── Test fixture IDs ─────────────────────────────────────────────────────────
const T1  = '11111111-2b2b-0000-0000-000000000001';
const WS1 = '11111111-2b2b-0000-0000-000000000002';
const T2  = '11111111-2b2b-0000-0000-000000000003';
const WS2 = '11111111-2b2b-0000-0000-000000000004';
const UID = '11111111-2b2b-0000-0000-000000000099';

// Reuse canonical entity IDs from Stage 2A fixture setup
// (these must be inserted by the integration helper first)
const BIZ1 = '22222222-aaaa-0000-0000-000000000001';
const BIZ2 = '22222222-aaaa-0000-0000-000000000002';
const CUST1 = '33333333-cccc-0000-0000-000000000001';
const SUPP1 = '44444444-4444-0000-0000-000000000001';
const INV_ITEM1 = '55555555-5555-0000-0000-000000000001';
const WH1  = '66666666-6666-0000-0000-000000000001';

const ctx1 = { tenantId: T1, workspaceId: WS1, userId: UID };
const ctx2 = { tenantId: T2, workspaceId: WS2, userId: UID };

let adminPool: Pool | null = null;

function uniqueCode(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function setupBOIntegration(): Promise<void> {
  const appUrl   = process.env.DATABASE_URL!;
  const adminUrl = process.env.ADMIN_DATABASE_URL ?? appUrl;

  createPool({ connectionString: appUrl });
  adminPool = new Pool({ connectionString: adminUrl });

  // Tenants + workspaces (if not already present)
  await adminPool.query(
    `INSERT INTO tenancy.tenants (id, name, slug, status, plan_code)
     VALUES ($1,'BO-Test Tenant 1','bo-t1','active','test'),
            ($2,'BO-Test Tenant 2','bo-t2','active','test')
     ON CONFLICT (id) DO NOTHING`,
    [T1, T2]
  );
  await adminPool.query(
    `INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status)
     VALUES ($1,$2,'BO-Test WS 1','bo-ws1','active'),
            ($3,$4,'BO-Test WS 2','bo-ws2','active')
     ON CONFLICT (id) DO NOTHING`,
    [WS1, T1, WS2, T2]
  );

  // Businesses
  await adminPool.query(
    `INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status)
     VALUES ($1,$2,$3,'BO Test Biz 1','bo-biz1','active'),
            ($4,$5,$6,'BO Test Biz 2','bo-biz2','active')
     ON CONFLICT (id) DO NOTHING`,
    [BIZ1, T1, WS1, BIZ2, T2, WS2]
  );

  // Customers
  await adminPool.query(
    `INSERT INTO platform.customers (id, tenant_id, workspace_id, business_id, display_name, status)
     VALUES ($1,$2,$3,$4,'BO Test Customer 1','active')
     ON CONFLICT (id) DO NOTHING`,
    [CUST1, T1, WS1, BIZ1]
  );

  // Suppliers
  await adminPool.query(
    `INSERT INTO platform.suppliers (id, tenant_id, workspace_id, business_id, name, supplier_code, status)
     VALUES ($1,$2,$3,$4,'BO Test Supplier 1','bo-sup1','active')
     ON CONFLICT (id) DO NOTHING`,
    [SUPP1, T1, WS1, BIZ1]
  );

  // Warehouses + inventory items
  await adminPool.query(
    `INSERT INTO platform.warehouses (id, tenant_id, workspace_id, business_id, warehouse_code, name, status)
     VALUES ($1,$2,$3,$4,'bo-wh1','BO Warehouse 1','active')
     ON CONFLICT (id) DO NOTHING`,
    [WH1, T1, WS1, BIZ1]
  );
  await adminPool.query(
    `INSERT INTO platform.inventory_items (id, tenant_id, workspace_id, business_id, sku, name, status)
     VALUES ($1,$2,$3,$4,'bo-sku1','BO Item 1','active')
     ON CONFLICT (id) DO NOTHING`,
    [INV_ITEM1, T1, WS1, BIZ1]
  );

  // Employee fixture — required for purchase_orders.approved_by FK
  await adminPool.query(
    `INSERT INTO platform.employees (id, tenant_id, workspace_id, business_id, employee_code, display_name, status)
     VALUES ($1,$2,$3,$4,'bo-emp-99','BO Test Approver','active')
     ON CONFLICT (id) DO NOTHING`,
    [UID, T1, WS1, BIZ1]
  );
}

async function teardownBOIntegration(): Promise<void> {
  if (adminPool) {
    const tenantFilter = [T1, T2];
    const clean = async (sql: string) => adminPool!.query(sql, [tenantFilter]);

    await clean(`DELETE FROM business_operations.bo_layer_deployments
                 WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM business_operations.bo_layer_assemblies
                 WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM business_operations.bo_handoff_records
                 WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM business_operations.bo_publication_packages
                 WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM business_operations.operational_performance_records
                 WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM business_operations.incident_escalations
                 WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM business_operations.incidents
                 WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM business_operations.risk_assessments
                 WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM business_operations.compliance_controls
                 WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM business_operations.case_activities
                 WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM business_operations.support_cases
                 WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM business_operations.expense_items
                 WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM business_operations.expense_claims
                 WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM business_operations.asset_inspections
                 WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM business_operations.maintenance_records
                 WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM business_operations.maintenance_schedules
                 WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM business_operations.resource_bookings
                 WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM business_operations.workflow_instances
                 WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM business_operations.task_assignments
                 WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM business_operations.tasks
                 WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM business_operations.work_schedules
                 WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM business_operations.employee_assignments
                 WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM business_operations.delivery_notes
                 WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM business_operations.fulfilment_items
                 WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM business_operations.fulfilment_orders
                 WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM business_operations.storage_locations
                 WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM business_operations.warehouse_zones
                 WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM business_operations.inventory_movements
                 WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM business_operations.inventory_balances
                 WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM business_operations.supplier_performance_scores
                 WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM business_operations.supplier_agreements
                 WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM business_operations.purchase_receipts
                 WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM business_operations.purchase_order_line_items
                 WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM business_operations.purchase_orders
                 WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM business_operations.credit_notes
                 WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM business_operations.payment_allocations
                 WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM business_operations.invoice_line_items
                 WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM business_operations.order_events
                 WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM business_operations.order_line_items
                 WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM business_operations.quotation_line_items
                 WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM business_operations.quotations
                 WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM business_operations.customer_accounts
                 WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM business_operations.opportunity_activities
                 WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM business_operations.opportunities
                 WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM business_operations.leads
                 WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM business_operations.role_assignments
                 WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM business_operations.department_responsibilities
                 WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM business_operations.business_profile_extensions
                 WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM business_operations.business_events
                 WHERE tenant_id = ANY($1)`);

    // Platform fixtures
    await adminPool.query(
      `DELETE FROM platform.inventory_items WHERE id = ANY($1)`,
      [[INV_ITEM1]]
    );
    await adminPool.query(
      `DELETE FROM platform.warehouses WHERE id = ANY($1)`,
      [[WH1]]
    );
    await adminPool.query(
      `DELETE FROM platform.employees WHERE id = ANY($1)`,
      [[UID]]
    );
    await adminPool.query(
      `DELETE FROM platform.suppliers WHERE id = ANY($1)`,
      [[SUPP1]]
    );
    await adminPool.query(
      `DELETE FROM platform.customers WHERE id = ANY($1)`,
      [[CUST1]]
    );
    await adminPool.query(
      `DELETE FROM platform.businesses WHERE id = ANY($1)`,
      [[BIZ1, BIZ2]]
    );

    await adminPool.end();
    adminPool = null;
  }
  await closePool();
}

// ── LeadRepository ────────────────────────────────────────────────────────────

describe.runIf(run)('LeadRepository', () => {
  const repo = new LeadRepository();

  beforeAll(setupBOIntegration);
  afterAll(teardownBOIntegration);

  it('creates a lead with auto correlationId', async () => {
    const lead = await repo.create(ctx1, {
      businessId: BIZ1,
      leadCode: uniqueCode('LEAD'),
      contactName: 'Alice Smith',
      leadSource: 'web',
    });
    expect(lead.id).toBeTruthy();
    expect(lead.leadStatus).toBe('new');
    expect(lead.correlationId).toBeTruthy();
    expect(lead.tenantId).toBe(T1);
    expect(lead.workspaceId).toBe(WS1);
  });

  it('findById returns created lead', async () => {
    const created = await repo.create(ctx1, {
      businessId: BIZ1,
      leadCode: uniqueCode('LEAD'),
      contactName: 'Bob Jones',
    });
    const found = await repo.findById(ctx1, created.id);
    expect(found.id).toBe(created.id);
    expect(found.contactName).toBe('Bob Jones');
  });

  it('findById throws NotFoundError for missing id', async () => {
    await expect(repo.findById(ctx1, '00000000-0000-0000-0000-000000000000'))
      .rejects.toThrow(NotFoundError);
  });

  it('updateStatus changes lead_status', async () => {
    const lead = await repo.create(ctx1, {
      businessId: BIZ1,
      leadCode: uniqueCode('LEAD'),
      contactName: 'Carol',
    });
    const updated = await repo.updateStatus(ctx1, lead.id, 'contacted');
    expect(updated.leadStatus).toBe('contacted');
  });

  it('convert sets lead_status to converted and links customer', async () => {
    const lead = await repo.create(ctx1, {
      businessId: BIZ1,
      leadCode: uniqueCode('LEAD'),
      contactName: 'Dave',
    });
    const converted = await repo.convert(ctx1, lead.id, CUST1);
    expect(converted.leadStatus).toBe('converted');
    expect(converted.customerId).toBe(CUST1);
    expect(converted.convertedAt).toBeTruthy();
  });

  it('tenant isolation: T2 cannot read T1 lead', async () => {
    const lead = await repo.create(ctx1, {
      businessId: BIZ1,
      leadCode: uniqueCode('LEAD'),
      contactName: 'Isolation Test',
    });
    await expect(repo.findById(ctx2, lead.id)).rejects.toThrow(NotFoundError);
  });

  it('listByStatus returns leads for given status', async () => {
    const code = uniqueCode('LEAD-LS');
    await repo.create(ctx1, { businessId: BIZ1, leadCode: code, contactName: 'New One', leadSource: 'referral' });
    const list = await repo.listByStatus(ctx1, 'new');
    expect(list.length).toBeGreaterThan(0);
    expect(list.every(l => l.tenantId === T1)).toBe(true);
  });
});

// ── OpportunityRepository ─────────────────────────────────────────────────────

describe.runIf(run)('OpportunityRepository', () => {
  const repo = new OpportunityRepository();

  beforeAll(setupBOIntegration);
  afterAll(teardownBOIntegration);

  it('creates an opportunity', async () => {
    const opp = await repo.create(ctx1, {
      businessId:      BIZ1,
      customerId:      CUST1,
      opportunityCode: uniqueCode('OPP'),
      name:            'Test Opportunity',
      estimatedValue:  50000,
    });
    expect(opp.id).toBeTruthy();
    expect(opp.stage).toBe('qualification');
    expect(opp.estimatedValue).toBe(50000);
  });

  it('findById returns opportunity', async () => {
    const opp = await repo.create(ctx1, {
      businessId:      BIZ1,
      customerId:      CUST1,
      opportunityCode: uniqueCode('OPP'),
      name:            'Find Me',
    });
    const found = await repo.findById(ctx1, opp.id);
    expect(found.name).toBe('Find Me');
  });

  it('advanceStage updates stage', async () => {
    const opp = await repo.create(ctx1, {
      businessId:      BIZ1,
      customerId:      CUST1,
      opportunityCode: uniqueCode('OPP'),
      name:            'Advance Stage',
    });
    const advanced = await repo.advanceStage(ctx1, opp.id, 'proposal');
    expect(advanced.stage).toBe('proposal');
  });

  it('close marks as closed_won', async () => {
    const opp = await repo.create(ctx1, {
      businessId:      BIZ1,
      customerId:      CUST1,
      opportunityCode: uniqueCode('OPP'),
      name:            'Close Won',
    });
    const closed = await repo.close(ctx1, opp.id, true);
    expect(closed.stage).toBe('closed_won');
    expect(closed.actualCloseDate).toBeTruthy();
  });

  it('close marks as closed_lost with reason', async () => {
    const opp = await repo.create(ctx1, {
      businessId:      BIZ1,
      customerId:      CUST1,
      opportunityCode: uniqueCode('OPP'),
      name:            'Close Lost',
    });
    const closed = await repo.close(ctx1, opp.id, false, 'Price too high');
    expect(closed.stage).toBe('closed_lost');
    expect(closed.lostReason).toBe('Price too high');
  });

  it('tenant isolation enforced', async () => {
    const opp = await repo.create(ctx1, {
      businessId:      BIZ1,
      customerId:      CUST1,
      opportunityCode: uniqueCode('OPP'),
      name:            'Isolated',
    });
    await expect(repo.findById(ctx2, opp.id)).rejects.toThrow(NotFoundError);
  });
});

// ── PurchaseOrderRepository ───────────────────────────────────────────────────

describe.runIf(run)('PurchaseOrderRepository', () => {
  const repo = new PurchaseOrderRepository();

  beforeAll(setupBOIntegration);
  afterAll(teardownBOIntegration);

  it('creates a purchase order', async () => {
    const po = await repo.create(ctx1, {
      businessId:   BIZ1,
      supplierId:   SUPP1,
      poNumber:     uniqueCode('PO'),
      totalAmount:  10000,
    });
    expect(po.id).toBeTruthy();
    expect(po.poStatus).toBe('draft');
    expect(po.totalAmount).toBe(10000);
  });

  it('findById returns purchase order', async () => {
    const po = await repo.create(ctx1, {
      businessId: BIZ1,
      supplierId: SUPP1,
      poNumber:   uniqueCode('PO'),
    });
    const found = await repo.findById(ctx1, po.id);
    expect(found.id).toBe(po.id);
  });

  it('approve sets status and approved_by after submission', async () => {
    const po = await repo.create(ctx1, {
      businessId: BIZ1,
      supplierId: SUPP1,
      poNumber:   uniqueCode('PO'),
    });
    const submitted = await repo.transitionStatus(ctx1, po.id, 'draft', 'submitted');
    expect(submitted.poStatus).toBe('submitted');

    const approved = await repo.approve(ctx1, po.id, UID);
    expect(approved.poStatus).toBe('approved');
    expect(approved.approvedBy).toBe(UID);
    expect(approved.approvedAt).toBeTruthy();
  });

  it('updateStatus advances PO lifecycle', async () => {
    const po = await repo.create(ctx1, {
      businessId: BIZ1,
      supplierId: SUPP1,
      poNumber:   uniqueCode('PO'),
    });
    const received = await repo.updateStatus(ctx1, po.id, 'received');
    expect(received.poStatus).toBe('received');
  });

  it('tenant isolation enforced', async () => {
    const po = await repo.create(ctx1, {
      businessId: BIZ1,
      supplierId: SUPP1,
      poNumber:   uniqueCode('PO'),
    });
    await expect(repo.findById(ctx2, po.id)).rejects.toThrow(NotFoundError);
  });
});

// ── SupportCaseRepository ─────────────────────────────────────────────────────

describe.runIf(run)('SupportCaseRepository', () => {
  const repo = new SupportCaseRepository();

  beforeAll(setupBOIntegration);
  afterAll(teardownBOIntegration);

  it('creates a support case', async () => {
    const sc = await repo.create(ctx1, {
      businessId:  BIZ1,
      customerId:  CUST1,
      caseNumber:  uniqueCode('CASE'),
      subject:     'Test Issue',
      priority:    'high',
    });
    expect(sc.id).toBeTruthy();
    expect(sc.caseStatus).toBe('open');
    expect(sc.priority).toBe('high');
  });

  it('findById returns support case', async () => {
    const sc = await repo.create(ctx1, {
      businessId: BIZ1,
      customerId: CUST1,
      caseNumber: uniqueCode('CASE'),
      subject:    'Find Me',
    });
    const found = await repo.findById(ctx1, sc.id);
    expect(found.subject).toBe('Find Me');
  });

  it('resolve sets status and resolution notes', async () => {
    const sc = await repo.create(ctx1, {
      businessId: BIZ1,
      customerId: CUST1,
      caseNumber: uniqueCode('CASE'),
      subject:    'Resolve Me',
    });
    const resolved = await repo.resolve(ctx1, sc.id, 'Fixed by reboot');
    expect(resolved.caseStatus).toBe('resolved');
    expect(resolved.resolutionNotes).toBe('Fixed by reboot');
    expect(resolved.resolvedAt).toBeTruthy();
  });

  it('listOpen returns only open cases for tenant', async () => {
    await repo.create(ctx1, {
      businessId: BIZ1,
      customerId: CUST1,
      caseNumber: uniqueCode('CASE'),
      subject:    'Open Case',
    });
    const list = await repo.listOpen(ctx1);
    expect(list.every(c => c.tenantId === T1)).toBe(true);
  });

  it('tenant isolation enforced', async () => {
    const sc = await repo.create(ctx1, {
      businessId: BIZ1,
      customerId: CUST1,
      caseNumber: uniqueCode('CASE'),
      subject:    'Isolated',
    });
    await expect(repo.findById(ctx2, sc.id)).rejects.toThrow(NotFoundError);
  });
});

// ── IncidentRepository ────────────────────────────────────────────────────────

describe.runIf(run)('IncidentRepository', () => {
  const repo = new IncidentRepository();

  beforeAll(setupBOIntegration);
  afterAll(teardownBOIntegration);

  it('creates an incident', async () => {
    const inc = await repo.create(ctx1, {
      businessId:   BIZ1,
      incidentCode: uniqueCode('INC'),
      title:        'Service Outage',
      incidentType: 'service_outage',
      severity:     'critical',
    });
    expect(inc.id).toBeTruthy();
    expect(inc.incidentStatus).toBe('open');
    expect(inc.severity).toBe('critical');
  });

  it('findById returns incident', async () => {
    const inc = await repo.create(ctx1, {
      businessId:   BIZ1,
      incidentCode: uniqueCode('INC'),
      title:        'Find Me',
      incidentType: 'operational',
    });
    const found = await repo.findById(ctx1, inc.id);
    expect(found.title).toBe('Find Me');
  });

  it('resolve sets status, rootCause, correctiveActions', async () => {
    const inc = await repo.create(ctx1, {
      businessId:   BIZ1,
      incidentCode: uniqueCode('INC'),
      title:        'Resolve Me',
      incidentType: 'safety',
    });
    const resolved = await repo.resolve(ctx1, inc.id, 'Hardware failure', 'Replace component');
    expect(resolved.incidentStatus).toBe('resolved');
    expect(resolved.rootCause).toBe('Hardware failure');
    expect(resolved.correctiveActions).toBe('Replace component');
  });

  it('tenant isolation enforced', async () => {
    const inc = await repo.create(ctx1, {
      businessId:   BIZ1,
      incidentCode: uniqueCode('INC'),
      title:        'Isolated',
      incidentType: 'compliance',
    });
    await expect(repo.findById(ctx2, inc.id)).rejects.toThrow(NotFoundError);
  });
});

// ── TaskRepository ────────────────────────────────────────────────────────────

describe.runIf(run)('TaskRepository', () => {
  const repo = new TaskRepository();

  beforeAll(setupBOIntegration);
  afterAll(teardownBOIntegration);

  it('creates a task', async () => {
    const task = await repo.create(ctx1, {
      businessId: BIZ1,
      taskCode:   uniqueCode('TASK'),
      title:      'Follow up with client',
      taskType:   'sales',
      priority:   'high',
    });
    expect(task.id).toBeTruthy();
    expect(task.taskStatus).toBe('open');
    expect(task.priority).toBe('high');
  });

  it('findById returns task', async () => {
    const task = await repo.create(ctx1, {
      businessId: BIZ1,
      taskCode:   uniqueCode('TASK'),
      title:      'Find Me Task',
    });
    const found = await repo.findById(ctx1, task.id);
    expect(found.title).toBe('Find Me Task');
  });

  it('updateStatus completes a task with completed_at', async () => {
    const task = await repo.create(ctx1, {
      businessId: BIZ1,
      taskCode:   uniqueCode('TASK'),
      title:      'Complete Me',
    });
    const done = await repo.updateStatus(ctx1, task.id, 'completed');
    expect(done.taskStatus).toBe('completed');
    expect(done.completedAt).toBeTruthy();
  });

  it('tenant isolation enforced', async () => {
    const task = await repo.create(ctx1, {
      businessId: BIZ1,
      taskCode:   uniqueCode('TASK'),
      title:      'Isolated Task',
    });
    await expect(repo.findById(ctx2, task.id)).rejects.toThrow(NotFoundError);
  });
});

// ── InventoryBalanceRepository ────────────────────────────────────────────────

describe.runIf(run)('InventoryBalanceRepository', () => {
  const repo = new InventoryBalanceRepository();
  let sharedBalId = '';

  beforeAll(async () => {
    await setupBOIntegration();
    // Create shared balance once — unique constraint prevents multiple rows per item+warehouse
    const bal = await repo.create(ctx1, {
      businessId:      BIZ1,
      inventoryItemId: INV_ITEM1,
      warehouseId:     WH1,
      quantityOnHand:  100,
      reorderPoint:    20,
      reorderQuantity: 50,
    });
    sharedBalId = bal.id;
  });
  afterAll(teardownBOIntegration);

  it('creates an inventory balance', async () => {
    const found = await repo.findByItemAndWarehouse(ctx1, INV_ITEM1, WH1);
    expect(found.id).toBeTruthy();
    expect(found.quantityOnHand).toBe(100);
    expect(found.quantityAvailable).toBe(100);
    expect(found.reorderPoint).toBe(20);
  });

  it('findByItemAndWarehouse returns balance', async () => {
    const found = await repo.findByItemAndWarehouse(ctx1, INV_ITEM1, WH1);
    expect(found.id).toBe(sharedBalId);
  });

  it('adjustQuantity increments stock', async () => {
    const before = await repo.findByItemAndWarehouse(ctx1, INV_ITEM1, WH1);
    const adjusted = await repo.adjustQuantity(ctx1, sharedBalId, 5);
    expect(adjusted.quantityOnHand).toBe(before.quantityOnHand + 5);
  });

  it('tenant isolation: T2 cannot see T1 balance', async () => {
    await expect(repo.findByItemAndWarehouse(ctx2, INV_ITEM1, WH1))
      .rejects.toThrow(NotFoundError);
  });

  it('tenant isolation: T2 cannot adjust T1 balance', async () => {
    await expect(repo.adjustQuantity(ctx2, sharedBalId, 1))
      .rejects.toThrow(NotFoundError);
  });
});

// ── BusinessEventRepository ──────────────────────────────────────────────────

describe.runIf(run)('BusinessEventRepository', () => {
  const repo = new BusinessEventRepository();
  const from = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
  const to = new Date(Date.now() + 24 * 60 * 60 * 1000);

  beforeAll(setupBOIntegration);
  afterAll(teardownBOIntegration);

  it('logs a sale event', async () => {
    const event = await repo.logEvent(ctx1, {
      businessId: BIZ1, eventType: 'sale', amount: 40, quantity: 1, customerId: 'cust-A',
    });
    expect(event.id).toBeTruthy();
    expect(event.eventType).toBe('sale');
    expect(event.amount).toBe(40);
  });

  it('aggregateSales sums revenue and finds top customer', async () => {
    await repo.logEvent(ctx1, { businessId: BIZ1, eventType: 'sale', amount: 100, customerId: 'cust-top' });
    await repo.logEvent(ctx1, { businessId: BIZ1, eventType: 'sale', amount: 50, customerId: 'cust-top' });
    await repo.logEvent(ctx1, { businessId: BIZ1, eventType: 'sale', amount: 10, customerId: 'cust-other' });
    const agg = await repo.aggregateSales(ctx1, BIZ1, from, to);
    expect(agg.totalRevenue).toBeGreaterThanOrEqual(200);
    expect(agg.topCustomer?.id).toBe('cust-top');
    expect(agg.topCustomer?.spend).toBe(150);
  });

  it('aggregateExpenses sums spend and groups by category', async () => {
    await repo.logEvent(ctx1, { businessId: BIZ1, eventType: 'expense', amount: 30, category: 'rent' });
    await repo.logEvent(ctx1, { businessId: BIZ1, eventType: 'expense', amount: 20, category: 'rent' });
    const agg = await repo.aggregateExpenses(ctx1, BIZ1, from, to);
    expect(agg.totalSpend).toBeGreaterThanOrEqual(50);
    const rent = agg.byCategory.find((c) => c.category === 'rent');
    expect(rent?.amount).toBe(50);
    expect(rent?.count).toBe(2);
  });

  it('aggregateInventory sums net units and groups by item', async () => {
    await repo.logEvent(ctx1, { businessId: BIZ1, eventType: 'inventory', quantity: 10, amount: 2, category: 'widgets' });
    await repo.logEvent(ctx1, { businessId: BIZ1, eventType: 'inventory', quantity: -3, amount: 2, category: 'widgets' });
    const agg = await repo.aggregateInventory(ctx1, BIZ1, from, to);
    const widgets = agg.topItems.find((i) => i.item === 'widgets');
    expect(widgets?.netUnits).toBe(7);
    expect(agg.totalCogs).toBeGreaterThanOrEqual(14);
  });

  it('aggregateCustomers computes churn rate and LTV', async () => {
    await repo.logEvent(ctx1, { businessId: BIZ1, eventType: 'customer', action: 'new', customerId: 'cust-new-1' });
    await repo.logEvent(ctx1, { businessId: BIZ1, eventType: 'customer', action: 'churn', customerId: 'cust-churn-1' });
    const agg = await repo.aggregateCustomers(ctx1, BIZ1, from, to);
    expect(agg.newCustomers).toBeGreaterThanOrEqual(1);
    expect(agg.churned).toBeGreaterThanOrEqual(1);
    expect(agg.churnRatePct).toBeGreaterThan(0);
  });

  it('aggregateTeam computes net headcount delta and hours', async () => {
    await repo.logEvent(ctx1, { businessId: BIZ1, eventType: 'team', action: 'hire', memberId: 'emp-1' });
    await repo.logEvent(ctx1, { businessId: BIZ1, eventType: 'team', action: 'hire', memberId: 'emp-2' });
    await repo.logEvent(ctx1, { businessId: BIZ1, eventType: 'team', action: 'fire', memberId: 'emp-3' });
    await repo.logEvent(ctx1, { businessId: BIZ1, eventType: 'team', quantity: 8, memberId: 'emp-1' });
    const agg = await repo.aggregateTeam(ctx1, BIZ1, from, to);
    expect(agg.netHeadcountDelta).toBeGreaterThanOrEqual(1);
    expect(agg.totalHoursLogged).toBeGreaterThanOrEqual(8);
  });

  it('tenant isolation: T2 aggregates do not see T1 events', async () => {
    const agg = await repo.aggregateSales(ctx2, BIZ1, from, to);
    expect(agg.transactionCount).toBe(0);
    expect(agg.totalRevenue).toBe(0);
  });
});
