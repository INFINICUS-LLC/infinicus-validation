/**
 * The staff screen's pure logic (WORK-WEB-1): the response contract (a copy of the existing Business Operations workforce-assignments read, validated on
 * every read), the request path and display helpers. No React, no network. Everything shown is a figure Business Operations returned for that row. No
 * allocation is added up across assignments, nothing is judged against today's date (the server's own status is shown), and nothing is invented.
 */
import { z } from 'zod';

export const workforceSchema = z.object({
  assignments: z.array(z.object({
    id: z.string().uuid(),
    employeeId: z.string().uuid(),
    employeeName: z.string(),
    employeeCode: z.string(),
    assignmentCode: z.string(),
    assignmentType: z.string(),
    title: z.string(),
    allocationPct: z.number().finite(),
    validFrom: z.string(),
    validTo: z.string().nullable(),
    status: z.string(),
  })),
});
export type WorkforceResponse = z.infer<typeof workforceSchema>;
export type AssignmentRow = WorkforceResponse['assignments'][number];

/** The most rows the API returns for one read (it clamps the limit to 100). A list of exactly this length may be cut short. */
export const WORKFORCE_LIMIT = 100;
export const mayBeTruncated = (count: number): boolean => count >= WORKFORCE_LIMIT;

export const workforcePath = (businessId: string): string =>
  `/v1/businesses/${encodeURIComponent(businessId)}/operations/workforce?limit=${WORKFORCE_LIMIT}`;

const PCT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
/** An allocation for reading ("50" -> "50%", "12.5" -> "12.5%"); null when it is not a finite number, which the page shows as unavailable. */
export function formatAllocation(pct: number): string | null {
  return Number.isFinite(pct) ? `${PCT.format(pct)}%` : null;
}

/** The UTC calendar date of a timestamp, or "unavailable" when it cannot be read. */
export function utcDate(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 'unavailable' : new Date(t).toISOString().slice(0, 10);
}

/** "2026-03-01 to 2026-09-30", or "from 2026-03-01, no end date" when the assignment has no end. */
export function validityText(validFrom: string, validTo: string | null): string {
  return validTo === null ? `from ${utcDate(validFrom)}, no end date` : `${utcDate(validFrom)} to ${utcDate(validTo)}`;
}
