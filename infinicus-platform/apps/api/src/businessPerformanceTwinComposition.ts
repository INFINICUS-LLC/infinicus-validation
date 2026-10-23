/**
 * The composition point of the Business Digital Twin representation of BI performance evidence (NEW-BDT-01). BDT consumes Business Intelligence REPORTS only:
 * the twin service is handed the read side of the BI financial and sales services, each built by its own BI composition (the one place BI is joined to Business
 * Operations). BDT never touches Business Operations and derives no KPI.
 */
import { BusinessPerformanceTwinService, type BusinessPerformanceTwinDependencies } from '@infinicus/workflow';
import { buildFinancialIntelligenceService } from './financialIntelligenceComposition.js';
import { buildSalesReportService } from './biSalesReportComposition.js';

export interface BusinessPerformanceTwinCompositionOptions { service?: BusinessPerformanceTwinService }

export function buildBusinessPerformanceTwinService(overrides: Partial<BusinessPerformanceTwinDependencies> = {}): BusinessPerformanceTwinService {
  return new BusinessPerformanceTwinService({ financial: buildFinancialIntelligenceService(), sales: buildSalesReportService(), ...overrides });
}
