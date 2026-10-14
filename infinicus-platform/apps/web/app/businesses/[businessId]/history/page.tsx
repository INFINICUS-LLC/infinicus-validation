import { DecisionWorkflowService } from '@infinicus/workflow';
import { requireServerContext } from '../../../../lib/serverContext';
import { WORKFLOW_VIEW_PERMISSIONS } from '../../../../lib/permissions';
import { AccessNotice } from '../../../access-notice';

export default async function HistoryPage({ params }: { params: Promise<{ businessId: string }> }) {
  const { businessId } = await params;
  // The history aggregates every layer, so it needs the same full read set as the workflow view.
  const access = await requireServerContext(WORKFLOW_VIEW_PERMISSIONS);
  if (!access.ok) return <AccessNotice reason={access.reason} />;

  const service = new DecisionWorkflowService();
  const [view, history] = await Promise.all([
    service.getWorkflowView(access.ctx, businessId),
    service.getDecisionHistory(access.ctx, businessId),
  ]);

  return (
    <div>
      <p><a href={`/businesses/${businessId}/workflow`}>&larr; Back to workflow</a></p>
      <h1>Decision history — {view.business.legalName}</h1>
      <p>
        Each stage is listed independently, most recent first — there is no
        single interleaved timeline across stages (see Known Limitations).
      </p>

      <HistorySection title="BI evidence" emptyLabel="No BI evidence yet.">
        {history.biEvidence.map((pkg) => (
          <tr key={pkg.id}><td>{pkg.packageCode}</td><td>{pkg.status}</td></tr>
        ))}
      </HistorySection>

      <HistorySection title="Simulation runs" emptyLabel="No simulation runs yet.">
        {history.simulationRuns.map((run) => (
          <tr key={run.id}><td>{run.runCode}</td><td>{run.status}</td></tr>
        ))}
      </HistorySection>

      <HistorySection title="ADI decision cases" emptyLabel="No ADI decision cases yet.">
        {history.adiCases.map((c) => (
          <tr key={c.id}><td>{c.caseCode}</td><td>{c.status}</td></tr>
        ))}
      </HistorySection>

      <HistorySection title="ABA reviews" emptyLabel="No ABA reviews yet.">
        {history.abaReviews.map((r) => (
          <tr key={r.id}><td>{r.reviewCode}</td><td>{r.status}</td></tr>
        ))}
      </HistorySection>

      <HistorySection title="Outcomes" emptyLabel="No outcomes recorded yet.">
        {history.outcomes.map((o) => (
          <tr key={o.id}><td>{o.observationCode}</td><td>{o.status}</td></tr>
        ))}
      </HistorySection>
    </div>
  );
}

function HistorySection({ title, emptyLabel, children }: { title: string; emptyLabel: string; children: React.ReactNode }) {
  const hasRows = Array.isArray(children) ? children.length > 0 : Boolean(children);
  return (
    <section className="card">
      <h2>{title}</h2>
      {hasRows ? (
        <table>
          <thead><tr><th scope="col">Code</th><th scope="col">Status</th></tr></thead>
          <tbody>{children}</tbody>
        </table>
      ) : (
        <p className="empty-state">{emptyLabel}</p>
      )}
    </section>
  );
}
