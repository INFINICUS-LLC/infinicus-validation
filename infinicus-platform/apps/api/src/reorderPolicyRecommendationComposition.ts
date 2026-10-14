/**
 * The ONE composition point of the AC-1 ADI reorder-policy recommendation producer.
 *
 * ADI (the workflow package) owns the recommendation; Business Operations owns the operational facts and the owner-approved rule set. ADI is
 * not allowed to import Business Operations, so this root joins them through a structural port: the read-only
 * {@link ReorderPolicyDerivationService} (loads BO facts, derives, verifies with the real evaluator, writes nothing) is handed to the producer
 * as its deriver, together with the BO evaluation recorder that binds the authoritative baseline to the proposal. No other file joins the two.
 *
 * AC-2 Block 7: ADI is also handed the GOVERNED evidence boundary - the Business Intelligence evidence service and the Business Digital Twin service (both built by
 * their own compositions) - and refuses to recommend without current, consistent BI and BDT evidence.
 */
import { ReorderPolicyBaselineEvidenceRecorder, ReorderPolicyDerivationService } from '@infinicus/business-operations-runtime';
import { ReorderPolicyRecommendationProducer, type ReorderPolicyDeriverPort, type ReorderPolicyRecommendationProducerDependencies } from '@infinicus/workflow';
import { buildInventoryBiEvidenceService } from './inventoryBiEvidenceComposition.js';
import { buildInventoryItemTwinService } from './inventoryItemTwinComposition.js';

export interface ReorderRecommendationCompositionOptions {
  /** Test seam: substitute the deriver. Production uses the Business Operations read-only derivation plus its evaluation recorder. */
  deriver?: ReorderPolicyDeriverPort;
  /** Test seam: substitute the governed evidence sources and/or the clock (production: the BI and BDT services). */
  evidence?: Partial<Pick<ReorderPolicyRecommendationProducerDependencies, 'bi' | 'twin' | 'now'>>;
}

export function buildReorderPolicyRecommendationProducer(options: ReorderRecommendationCompositionOptions = {}): ReorderPolicyRecommendationProducer {
  const derivation = new ReorderPolicyDerivationService();
  const recorder = new ReorderPolicyBaselineEvidenceRecorder();
  const deriver: ReorderPolicyDeriverPort = options.deriver ?? {
    derive: (ctx, request) => derivation.derive(ctx, request),
    recordBaselineEvidence: (ctx, request) => recorder.record(ctx, request),
  };
  const bi = buildInventoryBiEvidenceService();
  const twin = buildInventoryItemTwinService({ bi });
  return new ReorderPolicyRecommendationProducer({ deriver, bi: options.evidence?.bi ?? bi, twin: options.evidence?.twin ?? twin, ...(options.evidence?.now ? { now: options.evidence.now } : {}) });
}
