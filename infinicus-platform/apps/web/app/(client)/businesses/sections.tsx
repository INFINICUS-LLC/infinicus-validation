import type { BusinessList, DecisionHistory, WorkflowView } from '../../../lib/client/schemas';

/** Presentational only: no hooks, no data access. The pages fetch through the /v1 API and hand the validated result in. */

export function BusinessListView({ data }: { data: BusinessList }) {
  if (data.items.length === 0) return <p className="empty-state">No businesses found in this workspace yet.</p>;
  return (
    <ul className="business-list" aria-label="Businesses">
      {data.items.map((b) => (
        <li key={b.id}>
          <a href={`/businesses/${b.id}/workflow`}>
            <strong>{b.legalName}</strong>
            <br />
            <span className="status-badge">{b.status}</span>
            {b.industry ? <span> &middot; {b.industry}</span> : null}
          </a>
        </li>
      ))}
    </ul>
  );
}

export function WorkflowSections({ view }: { view: WorkflowView }) {
  return (
    <>
      <section className="card" aria-labelledby="data-review-heading">
        <h2 id="data-review-heading">Data review</h2>
        <table>
          <tbody>
            <tr><th scope="row">Legal name</th><td>{view.business.legalName}</td></tr>
            <tr><th scope="row">Trading name</th><td>{view.business.tradingName ?? '—'}</td></tr>
            <tr><th scope="row">Business code</th><td>{view.business.businessCode}</td></tr>
            <tr><th scope="row">Legal structure</th><td>{view.business.legalStructure ?? '—'}</td></tr>
            <tr><th scope="row">Business model</th><td>{view.business.businessModel ?? '—'}</td></tr>
          </tbody>
        </table>
      </section>

      <section className="card" aria-labelledby="bi-heading">
        <h2 id="bi-heading">BI evidence</h2>
        {view.biEvidence.length === 0 ? (
          <p className="empty-state">No BI evidence published for this business yet.</p>
        ) : (
          <table>
            <thead><tr><th scope="col">Package code</th><th scope="col">Status</th><th scope="col">Latest version</th></tr></thead>
            <tbody>
              {view.biEvidence.map((pkg) => (<tr key={pkg.id}><td>{pkg.packageCode}</td><td>{pkg.status}</td><td>{pkg.latestVersion}</td></tr>))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card" aria-labelledby="dt-heading">
        <h2 id="dt-heading">Digital twin state</h2>
        {view.dtLatestSnapshot ? (
          <table>
            <tbody>
              <tr><th scope="row">Snapshot code</th><td>{view.dtLatestSnapshot.snapshotCode}</td></tr>
              <tr><th scope="row">Status</th><td>{view.dtLatestSnapshot.status}</td></tr>
              <tr><th scope="row">Effective at</th><td>{new Date(view.dtLatestSnapshot.effectiveAt).toLocaleString()}</td></tr>
            </tbody>
          </table>
        ) : (
          <p className="empty-state">No published digital twin snapshot for this business yet.</p>
        )}
      </section>

      <section className="card" aria-labelledby="sim-heading">
        <h2 id="sim-heading">Simulation execution</h2>
        {view.simulationLatestResult ? (
          <table>
            <tbody>
              <tr><th scope="row">Result code</th><td>{view.simulationLatestResult.resultCode}</td></tr>
              <tr><th scope="row">Status</th><td>{view.simulationLatestResult.status}</td></tr>
            </tbody>
          </table>
        ) : (
          <p className="empty-state">No published simulation result for this business yet.</p>
        )}
        {view.simulationRuns.length > 0 && (
          <>
            <h3>Recent runs</h3>
            <table>
              <thead><tr><th scope="col">Run code</th><th scope="col">Status</th><th scope="col">Sample size</th></tr></thead>
              <tbody>
                {view.simulationRuns.map((run) => (<tr key={run.id}><td>{run.runCode}</td><td>{run.status}</td><td>{run.sampleSize}</td></tr>))}
              </tbody>
            </table>
          </>
        )}
      </section>

      <section className="card" aria-labelledby="adi-heading">
        <h2 id="adi-heading">ADI recommendation</h2>
        {view.adiLatestRecommendation ? (
          <table>
            <tbody>
              <tr><th scope="row">Recommendation code</th><td>{view.adiLatestRecommendation.recommendationCode}</td></tr>
              <tr><th scope="row">Status</th><td>{view.adiLatestRecommendation.status}</td></tr>
            </tbody>
          </table>
        ) : (
          <p className="empty-state">No published AI recommendation for this business yet.</p>
        )}
      </section>

      <section className="card" aria-labelledby="aba-heading">
        <h2 id="aba-heading">ABA review</h2>
        {view.abaLatestDecision ? (
          <p>Latest decision: <span className="status-badge">{view.abaLatestDecision.status}</span> ({view.abaLatestDecision.decisionCode})</p>
        ) : (
          <p className="empty-state">No approval decision recorded yet.</p>
        )}
      </section>

      <section className="card" aria-labelledby="outcome-heading">
        <h2 id="outcome-heading">Outcomes</h2>
        {view.outcomes.length === 0 ? (
          <p className="empty-state">No outcome observations recorded yet.</p>
        ) : (
          <table>
            <thead><tr><th scope="col">Observation code</th><th scope="col">Status</th></tr></thead>
            <tbody>
              {view.outcomes.map((obs) => (<tr key={obs.id}><td>{obs.observationCode}</td><td>{obs.status}</td></tr>))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

function HistorySection({ title, emptyLabel, rows }: { title: string; emptyLabel: string; rows: Array<{ id: string; code: string; status: string }> }) {
  return (
    <section className="card" aria-label={title}>
      <h2>{title}</h2>
      {rows.length === 0 ? (
        <p className="empty-state">{emptyLabel}</p>
      ) : (
        <table>
          <thead><tr><th scope="col">Code</th><th scope="col">Status</th></tr></thead>
          <tbody>{rows.map((r) => (<tr key={r.id}><td>{r.code}</td><td>{r.status}</td></tr>))}</tbody>
        </table>
      )}
    </section>
  );
}

export function HistorySections({ history }: { history: DecisionHistory }) {
  return (
    <>
      <HistorySection title="BI evidence" emptyLabel="No BI evidence yet." rows={history.biEvidence.map((r) => ({ id: r.id, code: r.packageCode, status: r.status }))} />
      <HistorySection title="Simulation runs" emptyLabel="No simulation runs yet." rows={history.simulationRuns.map((r) => ({ id: r.id, code: r.runCode, status: r.status }))} />
      <HistorySection title="ADI decision cases" emptyLabel="No ADI decision cases yet." rows={history.adiCases.map((r) => ({ id: r.id, code: r.caseCode, status: r.status }))} />
      <HistorySection title="ABA reviews" emptyLabel="No ABA reviews yet." rows={history.abaReviews.map((r) => ({ id: r.id, code: r.reviewCode, status: r.status }))} />
      <HistorySection title="Outcomes" emptyLabel="No outcomes recorded yet." rows={history.outcomes.map((r) => ({ id: r.id, code: r.observationCode, status: r.status }))} />
    </>
  );
}
