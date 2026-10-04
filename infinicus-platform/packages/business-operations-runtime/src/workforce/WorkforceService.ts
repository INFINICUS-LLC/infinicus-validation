import {
  BusinessEventRepository,
  type BusinessEvent,
  type TenantContext,
  withTenantTransaction,
} from '@infinicus/database';

export interface WorkforceAssignmentView {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeCode: string;
  assignmentCode: string;
  assignmentType: string;
  title: string;
  allocationPct: number;
  validFrom: Date;
  validTo: Date | null;
  status: string;
}

export class WorkforceService {
  constructor(private readonly events = new BusinessEventRepository()) {}

  async listAssignments(
    ctx: TenantContext,
    businessId: string,
    limit = 50
  ): Promise<WorkforceAssignmentView[]> {
    const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT a.id, a.employee_id, e.display_name, e.employee_code,
                a.assignment_code, a.assignment_type, a.title, a.allocation_pct,
                a.valid_from, a.valid_to, a.status
         FROM business_operations.employee_assignments a
         JOIN platform.employees e ON e.id = a.employee_id
         WHERE a.business_id = $1
         ORDER BY a.valid_from DESC, a.created_at DESC
         LIMIT $2`,
        [businessId, bounded]
      );
      return result.rows.map((row) => ({
        id: row.id as string,
        employeeId: row.employee_id as string,
        employeeName: row.display_name as string,
        employeeCode: row.employee_code as string,
        assignmentCode: row.assignment_code as string,
        assignmentType: row.assignment_type as string,
        title: row.title as string,
        allocationPct: Number(row.allocation_pct),
        validFrom: new Date(String(row.valid_from)),
        validTo: row.valid_to === null ? null : new Date(String(row.valid_to)),
        status: row.status as string,
      }));
    });
  }

  async recordWorkforceEvent(
    ctx: TenantContext,
    input: {
      businessId: string;
      memberId?: string;
      action?: 'hire' | 'fire' | 'review';
      hours?: number;
      notes?: string;
      correlationId?: string;
    }
  ): Promise<BusinessEvent> {
    return this.events.logEvent(ctx, {
      businessId: input.businessId,
      eventType: 'team',
      memberId: input.memberId,
      action: input.action,
      quantity: input.hours,
      notes: input.notes,
      correlationId: input.correlationId,
    });
  }
}
