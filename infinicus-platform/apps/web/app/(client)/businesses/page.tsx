'use client';

import { useState } from 'react';
import { businessListSchema } from '../../../lib/client/schemas';
import { StateNotice } from '../state-notice';
import { useAuth } from '../auth-provider';
import { useRequireWorkspace } from '../use-require-workspace';
import { useScopedResource } from '../use-scoped-resource';
import { BusinessListView } from './sections';

const PAGE_SIZE = 20;

export default function BusinessesPage() {
  const { state } = useAuth();
  const { scope } = useRequireWorkspace();
  const [page, setPage] = useState(1);
  const { resource, reload } = useScopedResource(scope ? `/v1/businesses?page=${page}&pageSize=${PAGE_SIZE}` : null, businessListSchema);

  if (!scope) return <StateNotice state={state} />;
  return (
    <div>
      <h1>Select a business</h1>
      {resource.kind === 'loading' ? <p role="status" aria-live="polite">Loading…</p> : null}
      {resource.kind === 'error' ? (<p className="notice danger" role="alert">{resource.message} <button type="button" className="secondary" onClick={reload}>Try again</button></p>) : null}
      {resource.kind === 'ok' ? (
        <>
          <BusinessListView data={resource.data} />
          <p>
            <button type="button" className="secondary" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Previous</button>{' '}
            <span>Page {resource.data.page} of {Math.max(1, Math.ceil(resource.data.total / resource.data.pageSize))}</span>{' '}
            <button type="button" className="secondary" disabled={page * PAGE_SIZE >= resource.data.total} onClick={() => setPage((p) => p + 1)}>Next</button>
          </p>
        </>
      ) : null}
    </div>
  );
}
