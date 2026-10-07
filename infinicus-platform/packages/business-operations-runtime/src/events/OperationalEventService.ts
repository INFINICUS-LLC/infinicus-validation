import {
  BusinessEventRepository,
  type BusinessEvent,
  type LogBusinessEventInput,
  type TenantContext,
} from '@infinicus/database';

export interface OperationsSummary {
  businessId: string;
  period: { from: Date; to: Date; days: number };
  sales: Awaited<ReturnType<BusinessEventRepository['aggregateSales']>>;
  expenses: Awaited<ReturnType<BusinessEventRepository['aggregateExpenses']>>;
  inventory: Awaited<ReturnType<BusinessEventRepository['aggregateInventory']>>;
  customers: Awaited<ReturnType<BusinessEventRepository['aggregateCustomers']>>;
  team: Awaited<ReturnType<BusinessEventRepository['aggregateTeam']>>;
}

export class OperationalEventService {
  constructor(private readonly events = new BusinessEventRepository()) {}

  async recordFact(ctx: TenantContext, input: LogBusinessEventInput): Promise<BusinessEvent> {
    return this.events.logEvent(ctx, input);
  }

  async getSummary(
    ctx: TenantContext,
    businessId: string,
    from: Date,
    to: Date
  ): Promise<OperationsSummary> {
    if (!(from instanceof Date) || Number.isNaN(from.getTime())) {
      throw new Error('from must be a valid date');
    }
    if (!(to instanceof Date) || Number.isNaN(to.getTime()) || to <= from) {
      throw new Error('to must be a valid date after from');
    }

    const [sales, expenses, inventory, customers, team] = await Promise.all([
      this.events.aggregateSales(ctx, businessId, from, to),
      this.events.aggregateExpenses(ctx, businessId, from, to),
      this.events.aggregateInventory(ctx, businessId, from, to),
      this.events.aggregateCustomers(ctx, businessId, from, to),
      this.events.aggregateTeam(ctx, businessId, from, to),
    ]);
    const days = Math.max(1, Math.ceil((to.getTime() - from.getTime()) / 86_400_000));

    return {
      businessId,
      period: { from, to, days },
      sales,
      expenses,
      inventory,
      customers,
      team,
    };
  }
}
