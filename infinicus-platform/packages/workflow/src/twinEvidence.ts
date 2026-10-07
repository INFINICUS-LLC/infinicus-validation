import type { TwinSnapshotResult } from './TwinComputationService.js';

/**
 * Whether the Digital Twin snapshot rests on any REAL recorded activity.
 *
 * Absence of evidence is not evidence of a good (or bad) business: a snapshot
 * built from an empty event ledger is all zeros, and zeros must never be turned
 * into statements such as "profitable" or "healthy churn" (Layer Guidance &
 * Cold-Start Standard: "NOT ENOUGH REAL DATA ... Confidence: LOW"). This module
 * is the single place that decides, from the snapshot numbers alone, which
 * areas have recorded activity. It is pure and has no I/O.
 */
export type AreaEvidence = 'sufficient' | 'insufficient';
export type OverallEvidence = 'sufficient' | 'partial' | 'insufficient';

export interface TwinEvidenceAssessment {
  /** `insufficient`: nothing was recorded; `partial`: some areas have activity; `sufficient`: all three do. */
  overall: OverallEvidence;
  financial: AreaEvidence;
  customers: AreaEvidence;
  team: AreaEvidence;
  /** Human-readable, truthful statement of what is and is not known. */
  message: string;
}

const AREA_LABELS: Record<'financial' | 'customers' | 'team', string> = {
  financial: 'sales and expenses',
  customers: 'customer activity',
  team: 'team changes',
};

function nonZero(value: number): boolean {
  return Number.isFinite(value) && value !== 0;
}

export function assessTwinEvidence(twin: TwinSnapshotResult): TwinEvidenceAssessment {
  const financial: AreaEvidence =
    nonZero(twin.financial.salesCount30d) || nonZero(twin.financial.revenue30d) ||
    nonZero(twin.financial.expenses30d) || nonZero(twin.financial.burnRatePerDay)
      ? 'sufficient' : 'insufficient';
  const customers: AreaEvidence =
    nonZero(twin.customers.new30d) || nonZero(twin.customers.returning30d) || nonZero(twin.customers.churned30d)
      ? 'sufficient' : 'insufficient';
  const team: AreaEvidence =
    nonZero(twin.team.hired30d) || nonZero(twin.team.terminated30d)
      ? 'sufficient' : 'insufficient';

  const areas = { financial, customers, team } as const;
  const missing = (Object.keys(areas) as (keyof typeof areas)[]).filter((area) => areas[area] === 'insufficient');

  if (missing.length === 3) {
    return {
      overall: 'insufficient', financial, customers, team,
      message:
        `Not enough real data yet. No sales, expenses, customer activity or team changes were recorded in the last ${twin.windowDays} days, ` +
        'so no conclusions are drawn. Confidence: LOW. Record real activity to receive recommendations.',
    };
  }
  if (missing.length > 0) {
    return {
      overall: 'partial', financial, customers, team,
      message:
        `Not enough real data for: ${missing.map((area) => AREA_LABELS[area]).join(', ')}. ` +
        'Recommendations cover only the areas with recorded activity.',
    };
  }
  return { overall: 'sufficient', financial, customers, team, message: 'Recorded activity exists in every area.' };
}
