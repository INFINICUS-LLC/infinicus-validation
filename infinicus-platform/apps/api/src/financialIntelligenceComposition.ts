/**
 * The ONE composition point of the Business Intelligence financial report (NEW-BI-01): it joins BI (packages/workflow) to the read-only Business Operations
 * financial facts service through the structural port, so BI never imports Business Operations.
 */
import { FinancialIntelligenceService, type FinancialFactsPort } from '@infinicus/workflow';
import { FinancialFactsService } from '@infinicus/business-operations-runtime';

export interface FinancialIntelligenceCompositionOptions { service?: FinancialIntelligenceService }

export function buildFinancialIntelligenceService(facts: FinancialFactsPort = new FinancialFactsService()): FinancialIntelligenceService {
  return new FinancialIntelligenceService({ facts });
}
