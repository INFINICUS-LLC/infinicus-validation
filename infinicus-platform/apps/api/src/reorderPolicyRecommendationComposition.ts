/**
 * The ONE composition point of the AC-1 ADI reorder-policy recommendation producer.
 *
 * ADI (the workflow package) owns the recommendation; Business Operations owns the operational facts and the owner-approved rule set. ADI is
 * not allowed to import Business Operations, so this root joins them through a structural port: the read-only
 * {@link ReorderPolicyDerivationService} (loads BO facts, derives, verifies with the real evaluator, writes nothing) is handed to the producer
 * as its deriver. No other file joins the two.
 */
import { ReorderPolicyDerivationService } from '@infinicus/business-operations-runtime';
import { ReorderPolicyRecommendationProducer, type ReorderPolicyDeriverPort } from '@infinicus/workflow';

export interface ReorderRecommendationCompositionOptions {
  /** Test seam: substitute the deriver. Production uses the Business Operations read-only derivation. */
  deriver?: ReorderPolicyDeriverPort;
}

export function buildReorderPolicyRecommendationProducer(options: ReorderRecommendationCompositionOptions = {}): ReorderPolicyRecommendationProducer {
  const deriver: ReorderPolicyDeriverPort = options.deriver ?? new ReorderPolicyDerivationService();
  return new ReorderPolicyRecommendationProducer({ deriver });
}
