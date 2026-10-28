/**
 * The data screen's pure logic (DATA-WEB-1): the response contracts (copies of the existing, read-only Data Acquisition reads for data sources and collection
 * runs, `da:read`), validated on every read, the request paths and display helpers. No React, no network. Everything shown is a value the service
 * returned for that row. Record counts are shown per run and never added up or turned into a rate, nothing is rated "good" or "bad" here, and connectors
 * (whose configuration references are not for display) are not read at all.
 */
import { z } from 'zod';

const count = z.number().int().nonnegative();
export const dataSourcesSchema = z.object({
  dataSources: z.array(z.object({
    id: z.string().uuid(),
    businessId: z.string().uuid().nullable(),
    name: z.string(),
    sourceCode: z.string(),
    sourceType: z.string(),
    sensitivityLevel: z.string(),
    description: z.string().nullable(),
    status: z.string(),
    version: z.number(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })),
});
export const collectionRunsSchema = z.object({
  runs: z.array(z.object({
    id: z.string().uuid(),
    businessId: z.string().uuid().nullable(),
    dataSourceId: z.string().uuid(),
    connectorId: z.string().uuid().nullable(),
    collectionType: z.string(),
    state: z.string(),
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
    recordsReceived: count,
    recordsAccepted: count,
    recordsRejected: count,
    errorCode: z.string().nullable(),
    errorMessage: z.string().nullable(),
    attemptNumber: z.number(),
    correlationId: z.string().uuid(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })),
});
export type DataSourcesResponse = z.infer<typeof dataSourcesSchema>;
export type CollectionRunsResponse = z.infer<typeof collectionRunsSchema>;
export type DataSourceRow = DataSourcesResponse['dataSources'][number];

/** The most rows one read asks for (the API allows up to 200). A list of exactly this length may be cut short. */
export const DATA_LIMIT = 100;
export const mayBeTruncated = (rowCount: number): boolean => rowCount >= DATA_LIMIT;

const base = (businessId: string): string => `/v1/businesses/${encodeURIComponent(businessId)}`;
export const dataSourcesPath = (businessId: string): string => `${base(businessId)}/data-sources?limit=${DATA_LIMIT}`;
export const collectionRunsPath = (businessId: string): string => `${base(businessId)}/collection-runs?limit=${DATA_LIMIT}`;

/** A timestamp as an unambiguous UTC date and time, or "unavailable" when it cannot be read. */
export function utcDateTime(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 'unavailable' : `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
/** A start or completion time, or the plain word for a run that has none (not started, not finished). */
export const runTime = (iso: string | null, none: string): string => (iso === null ? none : utcDateTime(iso));

/** The names of data sources by id, so a run can say which source it belongs to; a run whose source is not in the list is named by a short id. */
export function sourceNames(sources: readonly Pick<DataSourceRow, 'id' | 'name'>[]): Map<string, string> {
  return new Map(sources.map((s) => [s.id, s.name]));
}
export const sourceLabel = (names: Map<string, string>, id: string): string => names.get(id) ?? `source ${id.slice(0, 8)}`;
