/**
 * The delivery subscriptions of the authorized-action execution pipeline (P0-6e), as data. Event transport belongs to DATA: this file names
 * who receives which event; it executes, verifies and decides nothing.
 *
 *   control_loop.action.authorized@1 -> Business Operations intake/claim/execution consumer
 *   operations.action.executed@1     -> Outcome Monitoring execution-verification consumer
 *   operations.authorized_action.recovery_due@1 -> Business Operations stranded-claim recovery consumer (P0-6g; internal)
 *
 * `subscriber_name` is platform-unique, so each name carries the workspace it serves. Versions are pinned. The retry policy is the ruled
 * execution policy (O-3): at most 3 attempts, 1 s / 5 s / 15 s - BO's engine constants are asserted equal to these in tests.
 */
import { ACTION_AUTHORIZED_CONSUMER, ACTION_AUTHORIZED_EVENT_TYPE, ACTION_AUTHORIZED_EVENT_VERSION } from './action-authorized.js';
import { AUTHORIZED_ACTION_RECOVERY_CONSUMER, AUTHORIZED_ACTION_RECOVERY_EVENT_TYPE, AUTHORIZED_ACTION_RECOVERY_EVENT_VERSION } from './authorized-action-recovery.js';
import { ACTION_EXECUTED_CONSUMER, ACTION_EXECUTED_EVENT_TYPE, ACTION_EXECUTED_EVENT_VERSION } from './action-executed.js';

export interface ExecutionPipelineSubscriptionSpec {
  subscriberName: string;
  eventPattern: string;
  destinationType: 'in_process';
  destinationReference: string;
  supportedVersions: string[];
  retryPolicy: { maxAttempts: number; backoffSeconds: number[] };
}

export const EXECUTION_PIPELINE_RETRY_POLICY = Object.freeze({ maxAttempts: 3, backoffSeconds: Object.freeze([1, 5, 15]) });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The three subscriptions one workspace needs (activation provisions and verifies all of them atomically). Throws on a malformed workspace id (a name must never be built from untrusted text). */
export function executionPipelineSubscriptions(workspaceId: string): ExecutionPipelineSubscriptionSpec[] {
  if (typeof workspaceId !== 'string' || !UUID.test(workspaceId)) throw new Error('workspaceId must be a lowercase UUID');
  const retryPolicy = { maxAttempts: EXECUTION_PIPELINE_RETRY_POLICY.maxAttempts, backoffSeconds: [...EXECUTION_PIPELINE_RETRY_POLICY.backoffSeconds] };
  return [
    {
      subscriberName: `${ACTION_AUTHORIZED_CONSUMER}@${workspaceId}`, eventPattern: ACTION_AUTHORIZED_EVENT_TYPE, destinationType: 'in_process',
      destinationReference: ACTION_AUTHORIZED_CONSUMER, supportedVersions: [ACTION_AUTHORIZED_EVENT_VERSION], retryPolicy: { ...retryPolicy, backoffSeconds: [...retryPolicy.backoffSeconds] },
    },
    {
      subscriberName: `${ACTION_EXECUTED_CONSUMER}@${workspaceId}`, eventPattern: ACTION_EXECUTED_EVENT_TYPE, destinationType: 'in_process',
      destinationReference: ACTION_EXECUTED_CONSUMER, supportedVersions: [ACTION_EXECUTED_EVENT_VERSION], retryPolicy: { ...retryPolicy, backoffSeconds: [...retryPolicy.backoffSeconds] },
    },
    {
      subscriberName: `${AUTHORIZED_ACTION_RECOVERY_CONSUMER}@${workspaceId}`, eventPattern: AUTHORIZED_ACTION_RECOVERY_EVENT_TYPE, destinationType: 'in_process',
      destinationReference: AUTHORIZED_ACTION_RECOVERY_CONSUMER, supportedVersions: [AUTHORIZED_ACTION_RECOVERY_EVENT_VERSION], retryPolicy,
    },
  ];
}
