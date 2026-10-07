'use server';

import { redirect } from 'next/navigation';
import { DecisionWorkflowService, DEFAULT_APPROVER_ASSIGNMENT_CODE } from '@infinicus/workflow';
import { ensurePool } from '../../../../lib/db';
import { contextFromSearchParams, ctxQuery } from '../../../../lib/context';

function requireCtxFromForm(formData: FormData) {
  const ctx = contextFromSearchParams({
    tenantId: String(formData.get('tenantId') ?? ''),
    workspaceId: String(formData.get('workspaceId') ?? ''),
    userId: String(formData.get('userId') ?? ''),
  });
  if (!ctx) throw new Error('Missing tenant context.');
  return ctx;
}

export async function submitApprovalDecisionAction(formData: FormData): Promise<void> {
  ensurePool();
  const ctx = requireCtxFromForm(formData);
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

  redirect(`/businesses/${businessId}/workflow?${ctxQuery(ctx)}`);
}

export async function recordOutcomeAction(formData: FormData): Promise<void> {
  ensurePool();
  const ctx = requireCtxFromForm(formData);
  const businessId = String(formData.get('businessId'));

  const service = new DecisionWorkflowService();
  await service.recordOutcome(ctx, businessId, {
    monitoredActionId: String(formData.get('monitoredActionId')),
    observationCode: `obs-${Date.now()}`,
    summary: String(formData.get('summary') ?? ''),
    effectiveAt: new Date(),
  });

  redirect(`/businesses/${businessId}/workflow?${ctxQuery(ctx)}`);
}
