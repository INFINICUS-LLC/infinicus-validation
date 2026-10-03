import { type TenantContext } from '@infinicus/database';
import { AssetService } from './assets/AssetService.js';
import { BusinessIntakeService } from './intake/BusinessIntakeService.js';
import { InventoryService } from './inventory/InventoryService.js';
import { OperationalEventService, type OperationsSummary } from './events/OperationalEventService.js';
import { ProcurementService } from './procurement/ProcurementService.js';
import { OperationalPublicationService } from './publication/OperationalPublicationService.js';
import { SupplierService } from './suppliers/SupplierService.js';
import { WorkforceService } from './workforce/WorkforceService.js';

export class BusinessOperationsService {
  readonly intake = new BusinessIntakeService();
  readonly publication = new OperationalPublicationService();
  readonly events = new OperationalEventService();
  readonly inventory = new InventoryService();
  readonly procurement = new ProcurementService();
  readonly suppliers = new SupplierService();
  readonly workforce = new WorkforceService();
  readonly assets = new AssetService();

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

    return this.events.getSummary(ctx, businessId, from, to);
  }
}
