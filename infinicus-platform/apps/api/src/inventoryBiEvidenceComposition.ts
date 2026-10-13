/**
 * The ONE composition point of the Business Intelligence inventory evidence service (AC-2 Block 5): it joins BI (packages/workflow) to the read-only
 * Business Operations facts service through the structural port, so BI never imports Business Operations.
 */
import { InventoryBiEvidenceService, type InventoryBiEvidenceDependencies } from '@infinicus/workflow';
import { InventoryEvidenceFactsService } from '@infinicus/business-operations-runtime';

export interface InventoryBiEvidenceCompositionOptions { service?: InventoryBiEvidenceService }

export function buildInventoryBiEvidenceService(overrides: Partial<InventoryBiEvidenceDependencies> = {}): InventoryBiEvidenceService {
  return new InventoryBiEvidenceService({ facts: new InventoryEvidenceFactsService(), ...overrides });
}
