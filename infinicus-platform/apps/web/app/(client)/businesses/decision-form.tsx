'use client';

import { useRef, useState, type FormEvent } from 'react';
import type { Scope } from '../../../lib/client/apiClient';
import { DECISION_OUTCOMES, describeRequestError, newDecisionAttempt, submitDecision, type DecisionOutcome, type FieldErrors } from '../../../lib/client/lifecycle';
import { useAuth } from '../auth-provider';

const LABELS: Record<DecisionOutcome, string> = { approve: 'Approve', approve_with_modifications: 'Approve with modifications', reject: 'Reject' };

/** Start an ABA review for a pasted intake package and record the signed-in user's decision. The approver is never chosen here: the server uses the session. */
export function DecisionForm({ businessId, scope, onDone }: { businessId: string; scope: Scope; onDone: () => void }) {
  const { api } = useAuth();
  const [intakePackageId, setIntakePackageId] = useState('');
  const [summary, setSummary] = useState('');
  const [outcome, setOutcome] = useState<DecisionOutcome>('approve');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const attempt = useRef({ value: newDecisionAttempt(), fingerprint: '' });

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!api || busy) return;
    const fingerprint = JSON.stringify([businessId, intakePackageId.trim(), summary.trim(), outcome]);
    if (attempt.current.fingerprint !== fingerprint) attempt.current = { value: newDecisionAttempt(), fingerprint };   // changed inputs = a new submission; unchanged = a retry (replay)
    setBusy(true); setMessage(null); setErrors({});
    try {
      const result = await submitDecision(api, scope, businessId, { intakePackageId: intakePackageId.trim(), summary, outcome }, attempt.current.value);
      if (!result.ok) { setErrors(result.fieldErrors); return; }
      setMessage({ kind: 'success', text: `Decision recorded (${result.value.status}).` });
      setIntakePackageId(''); setSummary(''); setOutcome('approve');
      attempt.current = { value: newDecisionAttempt(), fingerprint: '' };
      onDone();
    } catch (error) {
      setMessage({ kind: 'error', text: describeRequestError(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <details>
      <summary>Start a review and record a decision</summary>
      <form className="stack" onSubmit={onSubmit} noValidate>
        <div>
          <label htmlFor="intakePackageId">ABA intake package ID</label>
          <input id="intakePackageId" required aria-required="true" aria-invalid={Boolean(errors.intakePackageId)} aria-describedby={errors.intakePackageId ? 'intake-error' : undefined} placeholder="uuid" value={intakePackageId} onChange={(e) => setIntakePackageId(e.target.value)} />
          {errors.intakePackageId ? <p id="intake-error" className="notice danger" role="alert">{errors.intakePackageId}</p> : null}
        </div>
        <div>
          <label htmlFor="aba-summary">Review summary</label>
          <textarea id="aba-summary" required aria-required="true" rows={3} aria-invalid={Boolean(errors.summary)} value={summary} onChange={(e) => setSummary(e.target.value)} />
          {errors.summary ? <p className="notice danger" role="alert">{errors.summary}</p> : null}
        </div>
        <div>
          <label htmlFor="decision-outcome">Decision</label>
          <select id="decision-outcome" value={outcome} onChange={(e) => setOutcome(e.target.value as DecisionOutcome)}>
            {DECISION_OUTCOMES.map((o) => (<option key={o} value={o}>{LABELS[o]}</option>))}
          </select>
        </div>
        {message ? <p className={`notice ${message.kind === 'error' ? 'danger' : 'success'}`} role={message.kind === 'error' ? 'alert' : 'status'}>{message.text}</p> : null}
        <button type="submit" disabled={busy}>{busy ? 'Submitting…' : 'Submit decision'}</button>
      </form>
    </details>
  );
}
