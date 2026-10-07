export type ReplayMode = 'DELIVERY_ONLY';

export interface ReplayAuthorization {
  approvedBy: string;
  reason: string;
  mode: ReplayMode;
  approvalActionId?: string | null;
}

export interface ReplayCandidate {
  eventType: string;
  sourceDomain?: string | null;
  aggregateType?: string | null;
}

const ACTION_EVENT = /(^|\.)(action|approval|execution|refund|payment|payout|transfer|purchase_order)(\.|$)/i;

export function assertReplayAuthorized(
  candidate: ReplayCandidate,
  authorization: ReplayAuthorization,
): void {
  if (!authorization.approvedBy?.trim()) throw new Error('replay_approver_required');
  if (!authorization.reason?.trim()) throw new Error('replay_reason_required');
  if (authorization.mode !== 'DELIVERY_ONLY') throw new Error('replay_must_be_delivery_only');

  // Action-related events may be re-delivered as evidence only. They cannot be
  // converted into a fresh business command by BUILD-33. Where the workflow
  // requires a new execution attempt, it must return through ABA and produce a
  // new formally authorized action.
  if (ACTION_EVENT.test(candidate.eventType) && !authorization.approvalActionId) {
    throw new Error('action_event_replay_requires_aba_reference');
  }
}
