import { AssetService } from './assets/AssetService.js';
import { InventoryService } from './inventory/InventoryService.js';
import { ProcurementService } from './procurement/ProcurementService.js';
import { SupplierService } from './suppliers/SupplierService.js';
import { WorkforceService } from './workforce/WorkforceService.js';

export class BusinessOperationsService {
  readonly inventory = new InventoryService();
  readonly procurement = new ProcurementService();
  readonly suppliers = new SupplierService();
  readonly workforce = new WorkforceService();
  readonly assets = new AssetService();
}
