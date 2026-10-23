/** CL-01: receive only an OM handoff that the single OM learning gate releases. No learning or activation occurs here. */
import type { CLIntakePackage, ReleasedCLPackageInput, TenantContext } from '@infinicus/database';
import type { LearningReleaseFactory } from '@infinicus/outcome-monitoring-runtime';
import { validateCL02Publication } from './CL02Validation.js';

export interface CLIntakeWriter {
  recordReleased(ctx: TenantContext, input: ReleasedCLPackageInput): Promise<{ package: CLIntakePackage; idempotentReplay: boolean }>;
}

export class CLIntakeService {
  constructor(
    private readonly releaseFactory: LearningReleaseFactory,
    private readonly writer: CLIntakeWriter,
  ) {
    if (typeof releaseFactory !== 'function' || typeof writer?.recordReleased !== 'function') {
      throw new TypeError('explicit OM release factory and CL intake writer are required');
    }
  }

  async receive(ctx: TenantContext, handoff: unknown): Promise<{ package: CLIntakePackage; idempotentReplay: boolean }> {
    let recorded: { package: CLIntakePackage; idempotentReplay: boolean } | undefined;
    const boundary = this.releaseFactory(async (released, evidence) => {
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
        cl02: validateCL02Publication(released),
      });
    });
    await boundary.release(ctx, handoff);
    if (!recorded) throw new Error('CL intake writer did not complete');
    return recorded;
  }
}
