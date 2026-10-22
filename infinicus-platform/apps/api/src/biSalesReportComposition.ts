/**
 * The ONE composition point of the Business Intelligence sales report (BI-SALES-1): it joins BI (packages/workflow) to Business Operations' read-only
 * sales facts through the structural port, so BI never imports Business Operations.
 */
import { SalesReportService } from '@infinicus/workflow';
import { SalesFactsService } from '@infinicus/business-operations-runtime';

export interface BiSalesReportCompositionOptions { service?: SalesReportService }

export function buildSalesReportService(): SalesReportService {
  return new SalesReportService(new SalesFactsService());
}
