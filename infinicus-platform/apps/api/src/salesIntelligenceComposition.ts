/**
 * The ONE composition point of the Business Intelligence sales and operations performance report (NEW-BI-02): it joins BI (packages/workflow) to the read-only
 * Business Operations sales facts service through the structural port, so BI never imports Business Operations.
 */
import { SalesIntelligenceService, type SalesFactsPort } from '@infinicus/workflow';
import { SalesFactsService } from '@infinicus/business-operations-runtime';

export interface SalesIntelligenceCompositionOptions { service?: SalesIntelligenceService }

export function buildSalesIntelligenceService(facts: SalesFactsPort = new SalesFactsService()): SalesIntelligenceService {
  return new SalesIntelligenceService({ facts });
}
