/**
 * Shared live-PostgreSQL fixture: a real OM monitored action built through the real ABA -> OM repositories
 * (intake -> review -> approver assignment -> approved decision -> approved action -> OM intake -> plan -> monitored action).
 */
import {
  ActionReviewRepository, ApproverAuthorityRepository, ApprovalDecisionRepository, ApprovedActionRepository, ABAPublicationRepository,
  OMIntakeRepository, MonitoringPlanRepository, MonitoredActionRepository, type TenantContext,
} from '@infinicus/database';
import { createAbaIntake, uc } from './abaFixtures.js';

/** Creates a monitored action for `businessId` in `ctx`'s tenant/workspace and returns its id. `ctx.userId` must be a member of that workspace. */
export async function createMonitoredAction(ctx: TenantContext, businessId: string): Promise<string> {
  const reviewRepo = new ActionReviewRepository();
  const authorityRepo = new ApproverAuthorityRepository();
  const decisionRepo = new ApprovalDecisionRepository();
  const actionRepo = new ApprovedActionRepository();

  const approve = async (tag: string) => {
    const intakePackageId = await createAbaIntake(ctx, businessId);
    const review = await reviewRepo.createReviewPackage(ctx, businessId, intakePackageId, uc(`review${tag}`));
    const assignment = await authorityRepo.createAssignment(ctx, businessId, ctx.userId, uc(`assign${tag}`));
    const { decision, version } = await decisionRepo.createDecision(ctx, businessId, review.id, assignment.id, uc(`dec${tag}`), 'om fixture decision');
    await decisionRepo.approve(ctx, decision.id, version.id);
    return actionRepo.createAction(ctx, businessId, decision.id, uc(`action${tag}`));
  };

  const first = await approve('1');
  const { package: abaPub } = await new ABAPublicationRepository().createPackage(ctx, businessId, first.id, uc('aba-pub'), 'outcome_monitoring', 'OM-01', uc('idem'));
  const { package: omPkg } = await new OMIntakeRepository().receivePackage(ctx, { businessId, abaPublicationPackageId: abaPub.id, intakeCode: uc('om-intake'), idempotencyKey: uc('idem') });
  const { plan } = await new MonitoringPlanRepository().createPlan(ctx, businessId, omPkg.id, uc('plan'), 'om fixture plan');

  const second = await approve('2');
  const { action } = await new MonitoredActionRepository().createMonitoredAction(ctx, businessId, plan.id, second.id, uc('mact'), 'om fixture monitored action');
  return action.id;
}
