import { DecisionWorkflowService } from '@infinicus/workflow';
import { requireServerContext } from '../../lib/serverContext';
import { BUSINESS_LIST_PERMISSIONS } from '../../lib/permissions';
import { AccessNotice } from '../access-notice';

export default async function BusinessesPage() {
  const access = await requireServerContext(BUSINESS_LIST_PERMISSIONS);
  if (!access.ok) return <AccessNotice reason={access.reason} />;

  const service = new DecisionWorkflowService();
  const { items: businesses } = await service.listBusinesses(access.ctx);

  return (
    <div>
      <h1>Select a business</h1>
      {businesses.length === 0 ? (
        <p className="empty-state">No businesses found in this workspace yet.</p>
      ) : (
        <ul className="business-list" aria-label="Businesses">
          {businesses.map((business) => (
            <li key={business.id}>
              <a href={`/businesses/${business.id}/workflow`}>
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
