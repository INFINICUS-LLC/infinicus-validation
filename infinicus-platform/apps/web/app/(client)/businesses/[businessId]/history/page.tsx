'use client';

import { useParams } from 'next/navigation';
import { z } from 'zod';
import { decisionHistorySchema } from '../../../../../lib/client/schemas';
import { StateNotice } from '../../../state-notice';
import { useAuth } from '../../../auth-provider';
import { useRequireWorkspace } from '../../../use-require-workspace';
import { useScopedResource } from '../../../use-scoped-resource';
import { HistorySections } from '../../sections';

const idSchema = z.string().uuid();

export default function HistoryPage() {
  const { state } = useAuth();
  const { scope } = useRequireWorkspace();
  const params = useParams<{ businessId: string }>();
  const businessId = idSchema.safeParse(params.businessId).success ? params.businessId : null;
  const { resource, reload } = useScopedResource(scope && businessId ? `/v1/businesses/${businessId}/history` : null, decisionHistorySchema);

  if (!scope) return <StateNotice state={state} />;
  if (!businessId) return <div className="card"><p className="notice danger" role="alert">That business address is not valid.</p><p><a href="/businesses">&larr; All businesses</a></p></div>;
  return (
    <div>
      <h1>Decision history</h1>
      <p>Each stage is listed independently, most recent first. There is no single interleaved timeline across stages.</p>
      {resource.kind === 'loading' ? <p role="status" aria-live="polite">Loading…</p> : null}
      {resource.kind === 'error' ? (<p className="notice danger" role="alert">{resource.message} <button type="button" className="secondary" onClick={reload}>Try again</button></p>) : null}
      {resource.kind === 'ok' ? <HistorySections history={resource.data} /> : null}
    </div>
  );
}
