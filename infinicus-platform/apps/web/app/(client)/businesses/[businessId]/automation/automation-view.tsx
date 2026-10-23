'use client';

import type { Resource } from '../../../../../lib/client/resource';
import {
  ANNOUNCED_CLASS_TEXT, ATTENTION_TEXT, CLAIM_STATE_TEXT, formatDuration, sortedCounts, statusText, utcDateTime,
  type ExecutionHealth, type OutcomeHealth,
} from '../../../../../lib/client/automationHealth';

const Duration = ({ seconds }: { seconds: number }) => {
  const text = formatDuration(seconds);
  return text === null ? <span className="notice danger" role="alert">unavailable</span> : <span>{text}</span>;
};
const Truncated = ({ what }: { what: string }) => <p className="notice" role="status">Only some {what} are listed. There may be more that are not shown here.</p>;
const Stat = ({ label, children }: { label: string; children: React.ReactNode }) => <div><dt>{label}</dt><dd>{children}</dd></div>;

function Execution({ h }: { h: ExecutionHealth }) {
  const window = formatDuration(h.windowSeconds);
  return <>
    <p><strong>{statusText(h.status)}</strong>. As of {utcDateTime(h.asOf)}; &ldquo;in window&rdquo; means the last {window ?? 'unavailable'}.</p>
    <h3>Claims</h3>
    <dl className="kpis">
      <Stat label="Open">{h.claims.open}</Stat>
      <Stat label="Stranded">{h.claims.stranded}</Stat>
      <Stat label="Retry overdue">{h.claims.retryDue}</Stat>
      <Stat label="In progress">{h.claims.inProgress}</Stat>
      <Stat label="Oldest stranded">{h.claims.oldestStrandedAgeSeconds === null ? 'none' : <Duration seconds={h.claims.oldestStrandedAgeSeconds} />}</Stat>
    </dl>
    {h.claims.truncated ? <Truncated what="claims" /> : null}
    {h.claims.attention.length > 0 ? <table className="auto">
      <caption>Claims that need attention</caption>
      <thead><tr><th scope="col">Claim</th><th scope="col">State</th><th scope="col">Action type</th><th scope="col">Attempts</th><th scope="col">Last attempt</th><th scope="col">Last reason</th><th scope="col">Overdue</th><th scope="col">Age</th></tr></thead>
      <tbody>{h.claims.attention.map((c) => <tr key={c.claimId}>
        <th scope="row"><small>{c.claimId}</small></th>
        <td>{CLAIM_STATE_TEXT[c.state]}</td>
        <td>{c.actionType ? `${c.actionType.code} (${c.actionType.schemaVersion})` : 'unknown'}</td>
        <td>{c.attempts}</td>
        <td>{c.lastAttemptedAt === null ? 'never' : utcDateTime(c.lastAttemptedAt)}</td>
        <td>{c.lastAttemptReasonCode ?? 'none'}</td>
        <td><Duration seconds={c.overdueSeconds} /></td>
        <td><Duration seconds={c.ageSeconds} /></td>
      </tr>)}</tbody>
    </table> : <p className="empty-state">No claims need attention.</p>}
    <h3>Executions</h3>
    <dl className="kpis">
      <Stat label="Succeeded">{h.executions.succeeded} ({h.executions.succeededInWindow} in window)</Stat>
      <Stat label="Failed">{h.executions.failed} ({h.executions.failedInWindow} in window)</Stat>
      <Stat label="Refused">{h.executions.refused} ({h.executions.refusedInWindow} in window)</Stat>
      <Stat label="Last recorded">{h.executions.lastExecutionRecordedAt === null ? 'none yet' : utcDateTime(h.executions.lastExecutionRecordedAt)}</Stat>
    </dl>
    {h.executions.reasons.length > 0 ? <table className="auto">
      <caption>Failed and refused executions by reason (reason codes are shown as the service recorded them)</caption>
      <thead><tr><th scope="col">Outcome</th><th scope="col">Reason</th><th scope="col">Total</th><th scope="col">In window</th><th scope="col">Latest</th></tr></thead>
      <tbody>{h.executions.reasons.map((r) => <tr key={`${r.outcome}-${r.reasonCode}`}>
        <th scope="row">{r.outcome === 'FAILED' ? 'Failed' : 'Refused'}</th><td>{r.reasonCode}</td><td>{r.total}</td><td>{r.inWindow}</td><td>{utcDateTime(r.latestRecordedAt)}</td>
      </tr>)}</tbody>
    </table> : null}
  </>;
}

function Outcome({ h }: { h: OutcomeHealth }) {
  const v = h.verification;
  return <>
    <p><strong>{statusText(h.status)}</strong>. As of {utcDateTime(h.asOf)}.</p>
    {h.attention.length > 0 ? <ul>{h.attention.map((a) => <li key={a}>{ATTENTION_TEXT[a]}</li>)}</ul> : null}
    <h3>Verification</h3>
    <dl className="kpis">
      <Stat label="Verifications">{v.total}</Stat>
      <Stat label="Execution verified">{v.executionVerified}</Stat>
      <Stat label="Awaiting outcome">{v.awaitingOutcome}</Stat>
      <Stat label="Inconclusive">{v.inconclusive}</Stat>
      <Stat label="Last verified">{v.lastVerifiedAt === null ? 'none yet' : utcDateTime(v.lastVerifiedAt)}</Stat>
    </dl>
    <p>Verified business outcomes are not supported yet ({v.verifiedOutcomes.rows} rows).{v.unsupportedStateRows > 0 ? ` ${v.unsupportedStateRows} records are in a state this version does not support.` : ''}</p>
    {sortedCounts(v.byExecutionOutcome).length > 0 ? <p>By execution outcome: {sortedCounts(v.byExecutionOutcome).map(([k, n]) => `${k} ${n}`).join(', ')}.</p> : null}
    <h3>Missing evidence</h3>
    <dl className="kpis">
      <Stat label="Monitored actions without verification">{h.missingEvidence.monitoredActionsWithoutVerification}</Stat>
      <Stat label="Verifications without a monitored action">{h.missingEvidence.verificationsWithoutMonitoredAction}</Stat>
      <Stat label="Announced, not verified">{h.missingEvidence.announcedNotVerified}</Stat>
    </dl>
    <h3>Announced executions</h3>
    <dl className="kpis">
      <Stat label="Total">{h.announcedExecutions.total}</Stat>
      <Stat label="Verified">{h.announcedExecutions.verified}</Stat>
      <Stat label="Awaiting delivery">{h.announcedExecutions.awaitingDelivery}</Stat>
      <Stat label="Dead-lettered">{h.announcedExecutions.deadLettered}</Stat>
      <Stat label="Delivered, not verified">{h.announcedExecutions.deliveredNotVerified}</Stat>
      <Stat label="Oldest awaiting">{h.announcedExecutions.oldestAwaitingAgeSeconds === null ? 'none' : <Duration seconds={h.announcedExecutions.oldestAwaitingAgeSeconds} />}</Stat>
    </dl>
    {h.announcedExecutions.truncated ? <Truncated what="announced executions" /> : null}
    {h.announcedExecutions.pending.length > 0 ? <table className="auto">
      <caption>Announced executions still pending</caption>
      <thead><tr><th scope="col">Event</th><th scope="col">Execution</th><th scope="col">State</th><th scope="col">Attempts</th><th scope="col">Occurred</th><th scope="col">Age</th></tr></thead>
      <tbody>{h.announcedExecutions.pending.map((p) => <tr key={p.outboxEventId}>
        <th scope="row"><small>{p.outboxEventId}</small></th><td>{p.executionId ?? 'unknown'}</td><td>{ANNOUNCED_CLASS_TEXT[p.class]}</td><td>{p.attempts}</td><td>{utcDateTime(p.occurredAt)}</td><td><Duration seconds={p.ageSeconds} /></td>
      </tr>)}</tbody>
    </table> : null}
    <h3>Failed verification attempts</h3>
    <p>{h.failedVerificationAttempts.total} in total, {h.failedVerificationAttempts.inWindow} in the last {formatDuration(h.windowSeconds) ?? 'unavailable'}.</p>
    {h.failedVerificationAttempts.byCode.length > 0 ? <table className="auto">
      <thead><tr><th scope="col">Failure code</th><th scope="col">Status</th><th scope="col">Total</th><th scope="col">In window</th><th scope="col">Latest</th></tr></thead>
      <tbody>{h.failedVerificationAttempts.byCode.map((c) => <tr key={`${c.failureCode}-${c.status}`}>
        <th scope="row">{c.failureCode}</th><td>{c.status}</td><td>{c.total}</td><td>{c.inWindow}</td><td>{utcDateTime(c.latestAt)}</td>
      </tr>)}</tbody>
    </table> : null}
    <h3>Dead letters</h3>
    <dl className="kpis">
      <Stat label="Pending">{h.deadLetters.pending}</Stat>
      <Stat label="Replayed">{h.deadLetters.replayed}</Stat>
      <Stat label="Abandoned">{h.deadLetters.abandoned}</Stat>
    </dl>
    {h.deadLetters.truncated ? <Truncated what="dead letters" /> : null}
    {h.deadLetters.items.length > 0 ? <table className="auto">
      <thead><tr><th scope="col">Dead letter</th><th scope="col">Execution</th><th scope="col">Code</th><th scope="col">Retryable</th><th scope="col">Attempts</th><th scope="col">First failed</th><th scope="col">Last failed</th></tr></thead>
      <tbody>{h.deadLetters.items.map((d) => <tr key={d.id}>
        <th scope="row"><small>{d.id}</small></th><td>{d.executionId ?? 'unknown'}</td><td>{d.code}</td>
        <td>{d.retryable === null ? 'unknown' : d.retryable ? 'yes' : 'no'}</td><td>{d.attempts}</td><td>{utcDateTime(d.firstFailedAt)}</td><td>{utcDateTime(d.lastFailedAt)}</td>
      </tr>)}</tbody>
    </table> : null}
    {sortedCounts(h.observationRecords.byStatus).length > 0 ? <p>Observation records by status: {sortedCounts(h.observationRecords.byStatus).map(([k, n]) => `${k} ${n}`).join(', ')}.</p> : null}
    <h3>What this view does not cover</h3>
    <p><small>{h.executionHealth.see}</small></p>
    <ul>{h.limitations.map((l) => <li key={l}>{l}</li>)}</ul>
  </>;
}

function Panel<T>({ id, title, resource, children }: { id: string; title: string; resource: Resource<T>; children: (data: T) => React.ReactNode }) {
  return <section className="card" aria-labelledby={id}>
    <h2 id={id}>{title}</h2>
    <div aria-live="polite" aria-busy={resource.kind === 'loading'}>
      {resource.kind === 'loading' ? <p role="status">Loading…</p> : null}
      {resource.kind === 'error' ? <p className="notice danger" role="alert">{resource.message}</p> : null}
      {resource.kind === 'ok' ? children(resource.data) : null}
    </div>
  </section>;
}

/** Read-only: every number, age, time and status is the service's. Nothing here retries, replays, recovers or changes anything. */
export function AutomationView({ execution, outcome }: { execution: Resource<ExecutionHealth>; outcome: Resource<OutcomeHealth> }) {
  return <div className="automation-view">
    <p><small>This view is for administrators. It only shows the state of automated actions and their verification; it does not retry, replay, recover or change anything.</small></p>
    <Panel id="exec-heading" title="Action execution" resource={execution}>{(h) => <Execution h={h} />}</Panel>
    <Panel id="out-heading" title="Outcome monitoring" resource={outcome}>{(h) => <Outcome h={h} />}</Panel>
  </div>;
}
