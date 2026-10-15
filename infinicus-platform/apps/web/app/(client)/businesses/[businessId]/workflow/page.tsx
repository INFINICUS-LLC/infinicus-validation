'use client';

import { useParams } from 'next/navigation';
import { z } from 'zod';
import { workflowViewSchema } from '../../../../../lib/client/schemas';
import { StateNotice } from '../../../state-notice';
import { useAuth } from '../../../auth-provider';
import { useRequireWorkspace } from '../../../use-require-workspace';
import { useScopedResource } from '../../../use-scoped-resource';
import { WorkflowSections } from '../../sections';
import { DecisionForm } from '../../decision-form';
import { OutcomeForm } from '../../outcome-form';

const idSchema = z.string().uuid();

export default function WorkflowPage() {
  const { state } = useAuth();
  const { scope } = useRequireWorkspace();
  const params = useParams<{ businessId: string }>();
  const businessId = idSchema.safeParse(params.businessId).success ? params.businessId : null;
  const { resource, reload } = useScopedResource(scope && businessId ? `/v1/businesses/${businessId}/workflow` : null, workflowViewSchema);

  if (!scope) return <StateNotice state={state} />;
  if (!businessId) return <div className="card"><p className="notice danger" role="alert">That business address is not valid.</p><p><a href="/businesses">&larr; All businesses</a></p></div>;
  if (resource.kind === 'loading') return <div className="card"><p role="status" aria-live="polite">Loading…</p></div>;
  if (resource.kind === 'error') return <div className="card"><p className="notice danger" role="alert">{resource.message}</p><p><button type="button" onClick={reload}>Try again</button> <a href="/businesses">&larr; All businesses</a></p></div>;

  const view = resource.data;
  return (
    <div>
      <p><a href="/businesses">&larr; All businesses</a></p>
      <h1>{view.business.legalName}</h1>
      <p>
        <span className="status-badge">{view.business.status}</span>
        {view.business.industry ? <span> &middot; {view.business.industry}</span> : null}
        {' · '}
        <a href={`/businesses/${businessId}/history`}>View decision history</a>
      </p>
      <WorkflowSections view={view} />
      <section className="card" aria-labelledby="decide-heading">
        <h2 id="decide-heading">Record a decision</h2>
        <DecisionForm businessId={businessId} scope={scope} onDone={reload} />
      </section>
      <section className="card" aria-labelledby="record-outcome-heading">
        <h2 id="record-outcome-heading">Record an outcome</h2>
        <OutcomeForm businessId={businessId} scope={scope} onDone={reload} />
      </section>
    </div>
  );
}
