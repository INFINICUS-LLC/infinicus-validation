import { DecisionWorkflowService } from '@infinicus/workflow';
import { ensurePool } from '../../lib/db';
import { contextFromSearchParams, ctxQuery, type SearchParams } from '../../lib/context';

export default async function BusinessesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const resolvedSearchParams = await searchParams;
  const ctx = contextFromSearchParams(resolvedSearchParams);

  if (!ctx) {
    return (
      <div className="card">
        <h1>Select a business</h1>
        <p className="notice">
          No tenant context is set. This build has no login flow yet (see
          Known Limitations) — enter a tenant, workspace, and user id
          directly to continue.
        </p>
        <form className="stack" method="get">
          <div>
            <label htmlFor="tenantId">Tenant ID</label>
            <input id="tenantId" name="tenantId" required aria-required="true" placeholder="uuid" />
          </div>
          <div>
            <label htmlFor="workspaceId">Workspace ID</label>
            <input id="workspaceId" name="workspaceId" required aria-required="true" placeholder="uuid" />
          </div>
          <div>
            <label htmlFor="userId">User ID</label>
            <input id="userId" name="userId" required aria-required="true" placeholder="uuid" />
          </div>
          <button type="submit">Continue</button>
        </form>
      </div>
    );
  }

  ensurePool();
  const service = new DecisionWorkflowService();
  const { items: businesses } = await service.listBusinesses(ctx);
  const query = ctxQuery(ctx);

  return (
    <div>
      <h1>Select a business</h1>
      {businesses.length === 0 ? (
        <p className="empty-state">No businesses found in this workspace yet.</p>
      ) : (
        <ul className="business-list" aria-label="Businesses">
          {businesses.map((business) => (
            <li key={business.id}>
              <a href={`/businesses/${business.id}/workflow?${query}`}>
                <strong>{business.legalName}</strong>
                <br />
                <span className="status-badge">{business.status}</span>
                {business.industry ? <span> &middot; {business.industry}</span> : null}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
