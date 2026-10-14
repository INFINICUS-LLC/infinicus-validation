'use server';

import { redirect } from 'next/navigation';
import { DecisionWorkflowService, DEFAULT_APPROVER_ASSIGNMENT_CODE } from '@infinicus/workflow';
import { requireServerContext } from '../../../../lib/serverContext';
import { DECISION_PERMISSIONS, OUTCOME_PERMISSIONS } from '../../../../lib/permissions';

/** Identity and scope come only from the server-validated session; form fields identify targets (businessId and ids) and nothing else. */
async function requireCtx(permissions: readonly string[]) {
  const result = await requireServerContext(permissions);
  if (!result.ok) throw new Error('Not authorized.');
  return result.ctx;
}

export async function submitApprovalDecisionAction(formData: FormData): Promise<void> {
  const ctx = await requireCtx(DECISION_PERMISSIONS);
  const businessId = String(formData.get('businessId'));
  const outcome = String(formData.get('outcome'));
  if (outcome !== 'approve' && outcome !== 'approve_with_modifications' && outcome !== 'reject') {
    throw new Error(`Invalid outcome: ${outcome}`);
  }

  const service = new DecisionWorkflowService();
  const review = await service.createReview(ctx, businessId, {
    intakePackageId: String(formData.get('intakePackageId')),
    reviewCode: `review-${Date.now()}`,
    summary: String(formData.get('summary') ?? ''),
  });
  await service.submitApprovalDecision(ctx, businessId, {
    reviewPackageId: review.id,
    assignmentCode: DEFAULT_APPROVER_ASSIGNMENT_CODE,
    decisionCode: `dec-${Date.now()}`,
    summary: String(formData.get('summary') ?? ''),
    outcome,
  });

  redirect(`/businesses/${encodeURIComponent(businessId)}/workflow`);
}

export async function recordOutcomeAction(formData: FormData): Promise<void> {
  const ctx = await requireCtx(OUTCOME_PERMISSIONS);
  const businessId = String(formData.get('businessId'));

  const service = new DecisionWorkflowService();
  await service.recordOutcome(ctx, businessId, {
    monitoredActionId: String(formData.get('monitoredActionId')),
    observationCode: `obs-${Date.now()}`,
    summary: String(formData.get('summary') ?? ''),
    effectiveAt: new Date(),
  });

  redirect(`/businesses/${encodeURIComponent(businessId)}/workflow`);
}
