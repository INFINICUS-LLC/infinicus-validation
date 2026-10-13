/**
 * The ONE composition point of the AC-1 ADI reorder-policy recommendation producer.
 *
 * ADI (the workflow package) owns the recommendation; Business Operations owns the operational facts and the owner-approved rule set. ADI is
 * not allowed to import Business Operations, so this root joins them through a structural port: the read-only
 * {@link ReorderPolicyDerivationService} (loads BO facts, derives, verifies with the real evaluator, writes nothing) is handed to the producer
 * as its deriver, together with the BO evaluation recorder that binds the authoritative baseline to the proposal. No other file joins the two.
 */
import { ReorderPolicyBaselineEvidenceRecorder, ReorderPolicyDerivationService } from '@infinicus/business-operations-runtime';
import { ReorderPolicyRecommendationProducer, type ReorderPolicyDeriverPort } from '@infinicus/workflow';

export interface ReorderRecommendationCompositionOptions {
  /** Test seam: substitute the deriver. Production uses the Business Operations read-only derivation plus its evaluation recorder. */
  deriver?: ReorderPolicyDeriverPort;
}

export function buildReorderPolicyRecommendationProducer(options: ReorderRecommendationCompositionOptions = {}): ReorderPolicyRecommendationProducer {
  const derivation = new ReorderPolicyDerivationService();
  const recorder = new ReorderPolicyBaselineEvidenceRecorder();
  const deriver: ReorderPolicyDeriverPort = options.deriver ?? {
    derive: (ctx, request) => derivation.derive(ctx, request),
    recordBaselineEvidence: (ctx, request) => recorder.record(ctx, request),
  };
  return new ReorderPolicyRecommendationProducer({ deriver });
}
