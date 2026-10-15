'use client';

import { useRef, useState, type FormEvent } from 'react';
import type { Scope } from '../../../lib/client/apiClient';
import { describeRequestError, newOutcomeAttempt, submitOutcome, type FieldErrors } from '../../../lib/client/lifecycle';
import { useAuth } from '../auth-provider';

/** Record an outcome observation for a pasted monitored action. Immutable once recorded, so a retry of the same submission is a replay. */
export function OutcomeForm({ businessId, scope, onDone }: { businessId: string; scope: Scope; onDone: () => void }) {
  const { api } = useAuth();
  const [monitoredActionId, setMonitoredActionId] = useState('');
  const [summary, setSummary] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const attempt = useRef({ value: newOutcomeAttempt(), fingerprint: '' });

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!api || busy) return;
    const fingerprint = JSON.stringify([businessId, monitoredActionId.trim(), summary.trim()]);
    if (attempt.current.fingerprint !== fingerprint) attempt.current = { value: newOutcomeAttempt(), fingerprint };
    setBusy(true); setMessage(null); setErrors({});
    try {
      const result = await submitOutcome(api, scope, businessId, { monitoredActionId: monitoredActionId.trim(), summary }, attempt.current.value);
      if (!result.ok) { setErrors(result.fieldErrors); return; }
      setMessage({ kind: 'success', text: `Outcome recorded (${result.value.status}).` });
      setMonitoredActionId(''); setSummary('');
      attempt.current = { value: newOutcomeAttempt(), fingerprint: '' };
      onDone();
    } catch (error) {
      setMessage({ kind: 'error', text: describeRequestError(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <details>
      <summary>Record an outcome</summary>
      <form className="stack" onSubmit={onSubmit} noValidate>
        <div>
          <label htmlFor="monitoredActionId">Monitored action ID</label>
          <input id="monitoredActionId" required aria-required="true" aria-invalid={Boolean(errors.monitoredActionId)} aria-describedby={errors.monitoredActionId ? 'action-error' : undefined} placeholder="uuid" value={monitoredActionId} onChange={(e) => setMonitoredActionId(e.target.value)} />
          {errors.monitoredActionId ? <p id="action-error" className="notice danger" role="alert">{errors.monitoredActionId}</p> : null}
        </div>
        <div>
          <label htmlFor="outcome-summary">Outcome summary</label>
          <textarea id="outcome-summary" required aria-required="true" rows={3} aria-invalid={Boolean(errors.summary)} value={summary} onChange={(e) => setSummary(e.target.value)} />
          {errors.summary ? <p className="notice danger" role="alert">{errors.summary}</p> : null}
        </div>
        {message ? <p className={`notice ${message.kind === 'error' ? 'danger' : 'success'}`} role={message.kind === 'error' ? 'alert' : 'status'}>{message.text}</p> : null}
        <button type="submit" disabled={busy}>{busy ? 'Recording…' : 'Record outcome'}</button>
      </form>
    </details>
  );
}
