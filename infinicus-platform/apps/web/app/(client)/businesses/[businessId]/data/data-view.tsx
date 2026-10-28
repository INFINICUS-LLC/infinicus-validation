'use client';

import type { Resource } from '../../../../../lib/client/resource';
import { mayBeTruncated, runTime, sourceLabel, sourceNames, utcDateTime, DATA_LIMIT, type CollectionRunsResponse, type DataSourcesResponse } from '../../../../../lib/client/dataAcquisition';

const Truncated = () => <p className="notice" role="status">Showing the {DATA_LIMIT} most recent rows. There may be more that are not listed here.</p>;

function Sources({ resource }: { resource: Resource<DataSourcesResponse> }) {
  return <section className="card" aria-labelledby="src-heading">
    <h2 id="src-heading">Data sources</h2>
    <div aria-live="polite" aria-busy={resource.kind === 'loading'}>
      {resource.kind === 'loading' ? <p role="status">Loading data sources…</p> : null}
      {resource.kind === 'error' ? <p className="notice danger" role="alert">{resource.message}</p> : null}
      {resource.kind === 'ok' && resource.data.dataSources.length === 0 ? <p className="empty-state">No data sources are registered for this business yet.</p> : null}
      {resource.kind === 'ok' && resource.data.dataSources.length > 0 ? <>
        {mayBeTruncated(resource.data.dataSources.length) ? <Truncated /> : null}
        <table className="data">
          <caption>Newest first.</caption>
          <thead><tr><th scope="col">Source</th><th scope="col">Code</th><th scope="col">Type</th><th scope="col">Sensitivity</th><th scope="col">Status</th><th scope="col">Registered</th><th scope="col">Updated</th></tr></thead>
          <tbody>{resource.data.dataSources.map((s) => <tr key={s.id}>
            <th scope="row">{s.name}{s.description ? <><br /><small>{s.description}</small></> : null}</th>
            <td>{s.sourceCode}</td><td>{s.sourceType}</td><td>{s.sensitivityLevel}</td><td>{s.status}</td>
            <td>{utcDateTime(s.createdAt)}</td><td>{utcDateTime(s.updatedAt)}</td>
          </tr>)}</tbody>
        </table>
      </> : null}
    </div>
  </section>;
}

function Runs({ resource, sources }: { resource: Resource<CollectionRunsResponse>; sources: Resource<DataSourcesResponse> }) {
  const names = sourceNames(sources.kind === 'ok' ? sources.data.dataSources : []);
  return <section className="card" aria-labelledby="run-heading">
    <h2 id="run-heading">Collection runs</h2>
    <div aria-live="polite" aria-busy={resource.kind === 'loading'}>
      {resource.kind === 'loading' ? <p role="status">Loading collection runs…</p> : null}
      {resource.kind === 'error' ? <p className="notice danger" role="alert">{resource.message}</p> : null}
      {resource.kind === 'ok' && resource.data.runs.length === 0 ? <p className="empty-state">No collection runs have happened for this business yet.</p> : null}
      {resource.kind === 'ok' && resource.data.runs.length > 0 ? <>
        {mayBeTruncated(resource.data.runs.length) ? <Truncated /> : null}
        <table className="data">
          <caption>Newest first. Record counts are shown for each run as the service recorded them and are not added together.</caption>
          <thead><tr><th scope="col">Source</th><th scope="col">Type</th><th scope="col">State</th><th scope="col">Started</th><th scope="col">Completed</th><th scope="col">Received</th><th scope="col">Accepted</th><th scope="col">Rejected</th><th scope="col">Attempt</th><th scope="col">Error</th></tr></thead>
          <tbody>{resource.data.runs.map((r) => <tr key={r.id}>
            <th scope="row">{sourceLabel(names, r.dataSourceId)}</th>
            <td>{r.collectionType}</td><td>{r.state}</td>
            <td>{runTime(r.startedAt, 'not started')}</td><td>{runTime(r.completedAt, 'not finished')}</td>
            <td>{r.recordsReceived}</td><td>{r.recordsAccepted}</td><td>{r.recordsRejected}</td><td>{r.attemptNumber}</td>
            <td>{r.errorCode === null && r.errorMessage === null ? 'none' : <>{r.errorCode ?? 'no code'}{r.errorMessage ? <><br /><small>{r.errorMessage}</small></> : null}</>}</td>
          </tr>)}</tbody>
        </table>
      </> : null}
    </div>
  </section>;
}

/** Read-only: every value is the service's for that row. Nothing is added up, rated, retried, imported or changed from here. */
export function DataView({ sources, runs }: { sources: Resource<DataSourcesResponse>; runs: Resource<CollectionRunsResponse> }) {
  return <div className="data-view">
    <p><small>This screen only shows registered data sources and what each collection run received. It does not import, register, retry or change anything.</small></p>
    <Sources resource={sources} />
    <Runs resource={runs} sources={sources} />
  </div>;
}
