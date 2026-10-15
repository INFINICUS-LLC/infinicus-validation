/**
 * Writes of the first lifecycle (NA-05): record an approval decision and record an outcome, through the /v1 API.
 *
 * Nothing sent here is authority. The body names TARGETS (the intake package or monitored action the user pasted, and the business in the URL) and the
 * user's own words; the approver is always the signed-in principal, the assignment is resolved and verified by the server, and the workspace claim is
 * re-checked per request. Each submission carries an Idempotency-Key and server-side-unique codes so a retry of the SAME attempt is a replay, not a
 * second record.
 */
import { z } from 'zod';
import { ApiContractError, ApiError, ApiUnavailableError, SessionExpiredError, type ApiClient, type Scope } from './apiClient';
import { decisionResultSchema, outcomeResultSchema } from './schemas';

export type DecisionOutcome = 'approve' | 'approve_with_modifications' | 'reject';
export const DECISION_OUTCOMES: readonly DecisionOutcome[] = ['approve', 'approve_with_modifications', 'reject'];

/** One user submission: a new idempotency key and server-unique record codes. Reuse the SAME attempt to retry the same submission (a replay, not a second record). */
export interface DecisionAttempt { idempotencyKey: string; reviewCode: string; decisionCode: string }
export interface OutcomeAttempt { idempotencyKey: string; observationCode: string; effectiveAt: string }
export const newDecisionAttempt = (): DecisionAttempt => ({ idempotencyKey: crypto.randomUUID(), reviewCode: `web-review-${crypto.randomUUID()}`, decisionCode: `web-decision-${crypto.randomUUID()}` });
/** `effectiveAt` is fixed when the attempt is created so a retry sends the identical body. */
export const newOutcomeAttempt = (now: () => Date = () => new Date()): OutcomeAttempt => ({ idempotencyKey: crypto.randomUUID(), observationCode: `web-obs-${crypto.randomUUID()}`, effectiveAt: now().toISOString() });

const uuid = z.string().uuid('Enter the ID exactly as shown (a UUID).');
const summary = z.string().trim().min(1, 'A summary is required.').max(10_000, 'The summary is too long.');

export const decisionInputSchema = z.object({
  intakePackageId: uuid, summary, outcome: z.enum(['approve', 'approve_with_modifications', 'reject']),
});
export const outcomeInputSchema = z.object({ monitoredActionId: uuid, summary });

export type FieldErrors = Record<string, string>;
export type SubmitResult<T> = { ok: true; value: T } | { ok: false; fieldErrors: FieldErrors };

function fieldErrorsOf(error: z.ZodError): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of error.issues) out[String(issue.path[0] ?? 'form')] ??= issue.message;
  return out;
}

export async function submitDecision(
  api: ApiClient, scope: Scope, businessId: string, input: unknown, attempt: DecisionAttempt,
): Promise<SubmitResult<z.infer<typeof decisionResultSchema>>> {
  const parsed = decisionInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, fieldErrors: fieldErrorsOf(parsed.error) };
  const value = await api.post(`/v1/businesses/${encodeURIComponent(businessId)}/decisions`, {
    scope, idempotencyKey: attempt.idempotencyKey, schema: decisionResultSchema,
    body: { intakePackageId: parsed.data.intakePackageId, reviewCode: attempt.reviewCode, summary: parsed.data.summary, decisionCode: attempt.decisionCode, outcome: parsed.data.outcome },
  });
  return { ok: true, value };
}

export async function submitOutcome(
  api: ApiClient, scope: Scope, businessId: string, input: unknown, attempt: OutcomeAttempt,
): Promise<SubmitResult<z.infer<typeof outcomeResultSchema>>> {
  const parsed = outcomeInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, fieldErrors: fieldErrorsOf(parsed.error) };
  const value = await api.post(`/v1/businesses/${encodeURIComponent(businessId)}/outcomes`, {
    scope, idempotencyKey: attempt.idempotencyKey, schema: outcomeResultSchema,
    body: { monitoredActionId: parsed.data.monitoredActionId, observationCode: attempt.observationCode, summary: parsed.data.summary, effectiveAt: attempt.effectiveAt },
  });
  return { ok: true, value };
}

/** A user-facing sentence for a failed request. Never echoes server text; carries the correlation id so support can find the request. */
export function describeRequestError(error: unknown): string {
  if (error instanceof SessionExpiredError) return 'Your session has ended. Please sign in again.';
  if (error instanceof ApiUnavailableError) return 'The service could not be reached. Check your connection and try again.';
  if (error instanceof ApiContractError) return 'The service answered in an unexpected format. Please try again later.';
  if (error instanceof ApiError) {
    const ref = error.correlationId ? ` (reference ${error.correlationId})` : '';
    if (error.status === 403) return `You do not have permission to do this in this workspace.${ref}`;
    if (error.status === 404) return `Not found in this workspace.${ref}`;
    if (error.status === 409) return `This conflicts with an existing record, or was already recorded.${ref}`;
    if (error.status === 400 || error.status === 422) return `The request was not accepted. Check the values and try again.${ref}`;
    if (error.status === 429) return `Too many requests. Wait a moment and try again.${ref}`;
    return `The service had a problem. Please try again.${ref}`;
  }
  return 'Something went wrong. Please try again.';
}
