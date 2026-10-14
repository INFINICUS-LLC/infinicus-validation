import { DecisionWorkflowService } from '@infinicus/workflow';
import { requireServerContext } from '../../../../lib/serverContext';
import { WORKFLOW_VIEW_PERMISSIONS } from '../../../../lib/permissions';
import { AccessNotice } from '../../../access-notice';
import { submitApprovalDecisionAction, recordOutcomeAction } from './actions';

export default async function WorkflowPage({ params }: { params: Promise<{ businessId: string }> }) {
  const { businessId } = await params;
  const access = await requireServerContext(WORKFLOW_VIEW_PERMISSIONS);
  if (!access.ok) return <AccessNotice reason={access.reason} />;

  const service = new DecisionWorkflowService();
  const view = await service.getWorkflowView(access.ctx, businessId);

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
              {view.biEvidence.map((pkg) => (
                <tr key={pkg.id}><td>{pkg.packageCode}</td><td>{pkg.status}</td><td>{pkg.latestVersion}</td></tr>
              ))}
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
                {view.simulationRuns.map((run) => (
                  <tr key={run.id}><td>{run.runCode}</td><td>{run.status}</td><td>{run.sampleSize}</td></tr>
                ))}
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
          <p>
            Latest decision: <span className="status-badge">{view.abaLatestDecision.status}</span>{' '}
            ({view.abaLatestDecision.decisionCode})
          </p>
        ) : (
          <p className="empty-state">No approval decision recorded yet.</p>
        )}
        <details>
          <summary>Start a review and record a decision</summary>
          <form className="stack" action={submitApprovalDecisionAction}>
            <input type="hidden" name="businessId" value={businessId} />
            <div>
              <label htmlFor="intakePackageId">ABA intake package ID</label>
              <input id="intakePackageId" name="intakePackageId" required aria-required="true" placeholder="uuid" />
            </div>
            <div>
              <label htmlFor="aba-summary">Review summary</label>
              <textarea id="aba-summary" name="summary" required aria-required="true" rows={3} />
            </div>
            <div>
              <label htmlFor="outcome">Decision</label>
              <select id="outcome" name="outcome" defaultValue="approve">
                <option value="approve">Approve</option>
                <option value="approve_with_modifications">Approve with modifications</option>
                <option value="reject">Reject</option>
              </select>
            </div>
            <button type="submit">Submit decision</button>
          </form>
        </details>
      </section>

      <section className="card" aria-labelledby="outcome-heading">
        <h2 id="outcome-heading">Outcome entry</h2>
        {view.outcomes.length === 0 ? (
          <p className="empty-state">No outcome observations recorded yet.</p>
        ) : (
          <table>
            <thead><tr><th scope="col">Observation code</th><th scope="col">Status</th></tr></thead>
            <tbody>
              {view.outcomes.map((obs) => (
                <tr key={obs.id}><td>{obs.observationCode}</td><td>{obs.status}</td></tr>
              ))}
            </tbody>
          </table>
        )}
        <details>
          <summary>Record an outcome</summary>
          <form className="stack" action={recordOutcomeAction}>
            <input type="hidden" name="businessId" value={businessId} />
            <div>
              <label htmlFor="monitoredActionId">Monitored action ID</label>
              <input id="monitoredActionId" name="monitoredActionId" required aria-required="true" placeholder="uuid" />
            </div>
            <div>
              <label htmlFor="outcome-summary">Outcome summary</label>
              <textarea id="outcome-summary" name="summary" required aria-required="true" rows={3} />
            </div>
            <button type="submit">Record outcome</button>
          </form>
        </details>
      </section>
    </div>
  );
}
