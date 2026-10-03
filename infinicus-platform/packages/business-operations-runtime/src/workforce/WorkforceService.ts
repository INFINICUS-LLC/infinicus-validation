import { BusinessEventRepository, type BusinessEvent, type TenantContext } from '@infinicus/database';

export class WorkforceService {
  constructor(private readonly events = new BusinessEventRepository()) {}

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
