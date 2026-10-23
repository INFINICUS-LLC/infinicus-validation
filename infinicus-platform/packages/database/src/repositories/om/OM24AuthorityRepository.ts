/** Read-only OM-24 authority lookup. No caller can supply a verdict or receipt as proof. */
import type { TenantContext } from '../../client.js';
import { withTenantTransaction } from '../../client.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class OM24AuthorityRepository {
  async hasVerifiedPublication(
    ctx: TenantContext,
    businessId: string,
    publicationPackageId: string,
    detail: Record<string, unknown>,
  ): Promise<boolean> {
    const receiptId = detail.publicationReceiptId;
    const verdictId = detail.outcomeVerdictId;
    const definitionId = detail.monitoringContractId;
    if (![businessId, publicationPackageId, receiptId, verdictId, definitionId].every((value) => typeof value === 'string' && UUID.test(value))) return false;
    const serialized = JSON.stringify(detail);
    return withTenantTransaction(ctx, async (client) => {
      const found = await client.query(
        `SELECT receipt.id
         FROM outcome_monitoring.om24_publication_receipts receipt
         JOIN outcome_monitoring.governed_outcome_verdicts verdict ON verdict.id = receipt.verdict_id
         JOIN outcome_monitoring.governed_measurement_definitions definition ON definition.id = verdict.definition_id
         JOIN outcome_monitoring.om_publication_packages publication ON publication.id = receipt.publication_package_id
         JOIN outcome_monitoring.learning_feedback_package_versions feedback_version ON feedback_version.id = receipt.feedback_package_version_id
         JOIN outcome_monitoring.learning_feedback_packages feedback ON feedback.id = feedback_version.feedback_package_id
         JOIN outcome_monitoring.outcome_reviews review ON review.id = feedback.review_id
         WHERE receipt.id = $1 AND receipt.publication_package_id = $2 AND receipt.business_id = $3
           AND receipt.tenant_id = $4 AND receipt.workspace_id = $5
           AND verdict.id = $6 AND definition.id = $7 AND verdict.outcome_state = 'OUTCOME_VERIFIED'
           AND verdict.observation_id = review.observation_id
           AND publication.business_id = $3 AND publication.tenant_id = $4 AND publication.workspace_id = $5
           AND publication.feedback_package_id = feedback.id AND publication.target_layer = 'continuous_learning'
           AND publication.target_block = 'CL-01' AND publication.publication_status IN ('dispatched','acknowledged')
           AND feedback.business_id = $3 AND feedback.tenant_id = $4 AND feedback.workspace_id = $5
           AND feedback_version.business_id = $3 AND feedback_version.tenant_id = $4 AND feedback_version.workspace_id = $5
           AND verdict.business_id = $3 AND verdict.tenant_id = $4 AND verdict.workspace_id = $5
           AND definition.business_id = $3 AND definition.tenant_id = $4 AND definition.workspace_id = $5
           AND receipt.governed_detail = $8::jsonb
           AND receipt.governed_detail_digest = ('sha256:' || encode(digest(receipt.governed_detail::text, 'sha256'), 'hex'))`,
        [receiptId, publicationPackageId, businessId, ctx.tenantId, ctx.workspaceId,
          verdictId, definitionId, serialized]
      );
      return found.rowCount === 1;
    });
  }
}
