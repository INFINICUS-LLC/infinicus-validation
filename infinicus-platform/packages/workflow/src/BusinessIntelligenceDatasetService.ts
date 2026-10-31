/**
 * BI-1 (BI-02 source-to-dataset mapping): a validated BO -> BI intake becomes a versioned analytical dataset.
 *
 * Thin by design: the caller's scope and an intake id in, the dataset version out. All persistence is one repository transaction; BI never writes an
 * operational table and never assigns a quality or completeness score it has not computed (they stay NULL). Replays return the same dataset version.
 */
import { IntakeDatasetRepository, IntakeNotMaterializableError, type IntakeDatasetResult, type TenantContext } from '@infinicus/database';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export { IntakeNotMaterializableError };
export type { IntakeDatasetResult };

export class BusinessIntelligenceDatasetService {
  constructor(private readonly repository: IntakeDatasetRepository = new IntakeDatasetRepository()) {}

  /** Materializes the intake as the next version of its dataset. Throws IntakeNotMaterializableError (stable reason code) when it cannot. */
  async materialize(ctx: TenantContext, intakePackageId: string): Promise<IntakeDatasetResult> {
    if (typeof intakePackageId !== 'string' || !UUID.test(intakePackageId)) throw new IntakeNotMaterializableError('intake_package_id_not_a_uuid');
    return this.repository.materialize(ctx, intakePackageId.toLowerCase());
  }
}
