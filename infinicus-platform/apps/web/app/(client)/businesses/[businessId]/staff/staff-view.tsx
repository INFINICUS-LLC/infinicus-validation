'use client';

import type { Resource } from '../../../../../lib/client/resource';
import { formatAllocation, mayBeTruncated, validityText, WORKFORCE_LIMIT, type WorkforceResponse } from '../../../../../lib/client/workforce';

/** Read-only: every value is the Business Operations record for that assignment. Nothing is added up, edited or assigned from here. */
export function StaffView({ resource }: { resource: Resource<WorkforceResponse> }) {
  return <div className="staff-view" aria-live="polite" aria-busy={resource.kind === 'loading'}>
    {resource.kind === 'loading' ? <p role="status">Loading assignments…</p> : null}
    {resource.kind === 'error' ? <p className="notice danger" role="alert">{resource.message}</p> : null}
    {resource.kind === 'ok' && resource.data.assignments.length === 0
      ? <p className="empty-state">No staff assignments are recorded for this business yet.</p> : null}
    {resource.kind === 'ok' && resource.data.assignments.length > 0 ? <section className="card" aria-labelledby="staff-heading">
      <h2 id="staff-heading">Assignments</h2>
      {mayBeTruncated(resource.data.assignments.length)
        ? <p className="notice" role="status">Showing the {WORKFORCE_LIMIT} most recent assignments. There may be more that are not listed here.</p> : null}
      <p><small>Most recent start first. Each person&apos;s allocation is shown per assignment and is not added together. This screen only shows assignments; it does not hire, assign or change anything.</small></p>
      <table className="staff">
        <thead><tr><th scope="col">Person</th><th scope="col">Assignment</th><th scope="col">Type</th><th scope="col">Allocation</th><th scope="col">Valid</th><th scope="col">Status</th></tr></thead>
        <tbody>{resource.data.assignments.map((a) => {
          const allocation = formatAllocation(a.allocationPct);
          return <tr key={a.id}>
            <th scope="row">{a.employeeName}<br /><small>{a.employeeCode}</small></th>
            <td>{a.title}<br /><small>{a.assignmentCode}</small></td>
            <td>{a.assignmentType}</td>
            <td>{allocation === null ? <span className="notice danger" role="alert">unavailable</span> : allocation}</td>
            <td>{validityText(a.validFrom, a.validTo)}</td>
            <td>{a.status}</td>
          </tr>;
        })}</tbody>
      </table>
    </section> : null}
  </div>;
}
