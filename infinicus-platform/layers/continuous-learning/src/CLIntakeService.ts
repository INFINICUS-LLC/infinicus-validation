/** CL-01: receive only an OM handoff that the single OM learning gate releases. No learning or activation occurs here. */
import { ActionExecutionVerificationRepository, CLIntakeRepository } from '@infinicus/database';
import type { CLIntakePackage, ReleasedCLPackageInput, TenantContext } from '@infinicus/database';
import { LearningReleaseBoundary } from '@infinicus/outcome-monitoring-runtime';
import type { LearningSourceReader } from '@infinicus/outcome-monitoring-runtime';

export interface CLIntakeWriter {
  recordReleased(ctx: TenantContext, input: ReleasedCLPackageInput): Promise<{ package: CLIntakePackage; idempotentReplay: boolean }>;
}

export class CLIntakeService {
  constructor(
    private readonly sources: LearningSourceReader = new ActionExecutionVerificationRepository(),
    private readonly writer: CLIntakeWriter = new CLIntakeRepository(),
  ) {}

  async receive(ctx: TenantContext, handoff: unknown): Promise<{ package: CLIntakePackage; idempotentReplay: boolean }> {
    let recorded: { package: CLIntakePackage; idempotentReplay: boolean } | undefined;
    const boundary = new LearningReleaseBoundary({
      sources: this.sources,
      sink: async (released, evidence) => {
        const payload = released.payload;
        recorded = await this.writer.recordReleased(ctx, {
          businessId: payload.businessId,
          omPublicationPackageId: payload.omPublicationPackageId,
          feedbackPackageId: payload.feedbackPackageId,
          feedbackPackageVersionId: payload.feedbackPackageVersionId,
          observationId: payload.observationId,
          observationVersionId: payload.observationVersionId,
          idempotencyKey: payload.idempotencyKey,
          correlationId: released.correlationId,
          executions: evidence.executions,
        });
      },
    });
    await boundary.release(ctx, handoff);
    if (!recorded) throw new Error('CL intake writer did not complete');
    return recorded;
  }
}
