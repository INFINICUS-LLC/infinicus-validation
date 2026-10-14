/**
 * The composition point of the Business Digital Twin inventory item state (AC-2 Block 6). BDT consumes Business Intelligence evidence only: the twin service is
 * handed the BI service's read side, built by the BI composition (the one place BI is joined to Business Operations). BDT never touches Business Operations.
 */
import { InventoryItemTwinService, type InventoryItemTwinDependencies } from '@infinicus/workflow';
import { buildInventoryBiEvidenceService } from './inventoryBiEvidenceComposition.js';

export interface InventoryItemTwinCompositionOptions { service?: InventoryItemTwinService }

export function buildInventoryItemTwinService(overrides: Partial<InventoryItemTwinDependencies> = {}): InventoryItemTwinService {
  return new InventoryItemTwinService({ bi: buildInventoryBiEvidenceService(), ...overrides });
}
