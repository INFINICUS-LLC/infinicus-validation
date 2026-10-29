'use client';

import type { Resource } from '../../../../../lib/client/resource';
import { changeLabel, utcDateTime, type DeclaredCurrencyHistoryResponse, type DeclaredCurrencyResponse } from '../../../../../lib/client/businessAdministration';

function Current({ resource }: { resource: Resource<DeclaredCurrencyResponse> }) {
  return <section className="card" aria-labelledby="cur-heading">
    <h2 id="cur-heading">Declared currency</h2>
    <div aria-live="polite" aria-busy={resource.kind === 'loading'}>
      {resource.kind === 'loading' ? <p role="status">Loading the declared currency…</p> : null}
      {resource.kind === 'error' ? <p className="notice danger" role="alert">{resource.message}</p> : null}
      {resource.kind === 'ok' && resource.data.declaration === null ? <p className="empty-state">This business has not declared a currency yet. No default is assumed.</p> : null}
      {resource.kind === 'ok' && resource.data.declaration !== null ? <dl className="kv">
        <dt>Currency</dt><dd>{resource.data.declaration.currency}</dd>
        <dt>Version</dt><dd>{resource.data.declaration.version}</dd>
        <dt>Declared</dt><dd>{utcDateTime(resource.data.declaration.declaredAt)}</dd>
        <dt>Change</dt><dd>{changeLabel(resource.data.declaration)}</dd>
        {resource.data.declaration.reason ? <><dt>Reason</dt><dd>{resource.data.declaration.reason}</dd></> : null}
      </dl> : null}
    </div>
  </section>;
}

function History({ resource }: { resource: Resource<DeclaredCurrencyHistoryResponse> }) {
  return <section className="card" aria-labelledby="hist-heading">
    <h2 id="hist-heading">Declaration history</h2>
    <div aria-live="polite" aria-busy={resource.kind === 'loading'}>
      {resource.kind === 'loading' ? <p role="status">Loading the history…</p> : null}
      {resource.kind === 'error' ? <p className="notice danger" role="alert">{resource.message}</p> : null}
      {resource.kind === 'ok' && resource.data.items.length === 0 ? <p className="empty-state">No currency has ever been declared for this business.</p> : null}
      {resource.kind === 'ok' && resource.data.items.length > 0 ? <table className="data">
        <caption>Oldest first.</caption>
        <thead><tr><th scope="col">Version</th><th scope="col">Currency</th><th scope="col">Change</th><th scope="col">Declared</th><th scope="col">Reason</th></tr></thead>
        <tbody>{resource.data.items.map((d) => <tr key={d.declarationId}>
          <th scope="row">{d.version}</th><td>{d.currency}</td><td>{changeLabel(d)}</td><td>{utcDateTime(d.declaredAt)}</td><td>{d.reason ?? 'none'}</td>
        </tr>)}</tbody>
      </table> : null}
    </div>
  </section>;
}

/** Read-only: the declared currency and its history as the service returned them. Nothing is declared, changed or converted from here. */
export function BusinessView({ current, history }: { current: Resource<DeclaredCurrencyResponse>; history: Resource<DeclaredCurrencyHistoryResponse> }) {
  return <div className="data-view">
    <p><small>This screen only shows the currency this business has declared. It does not declare or change it, and no amount is converted.</small></p>
    <Current resource={current} />
    <History resource={history} />
  </div>;
}
