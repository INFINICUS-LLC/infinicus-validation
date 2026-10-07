export type {
  BusinessDomain,
  BusinessEventSensitivity,
  BusinessEventActorType,
  EvidenceClass,
  BusinessEventActor,
  BusinessEventProvenance,
  BusinessEventEnvelope,
  BusinessEventValidationResult,
} from './business-event.js';
export { validateBusinessEventEnvelope } from './business-event.js';
export type {
  ContractStatus,
  BusinessEventContract,
  RegisteredValidationResult,
} from './registry.js';
export { BusinessEventContractRegistry, LEGACY_EVENT_ALIASES } from './registry.js';

// @infinicus/event-contracts — canonical PlatformEvent and layer event types (CLAUDE.md § 9)
export type { PlatformEvent, LayerId } from '@infinicus/shared-types';

/**
 * All canonical event type strings use lowercase dot notation.
 * Examples: da.data.published  bo.order.completed  simulation.completed
 */
export type LayerEventType =
  // DAL
  | 'da.data.published'
  // BO
  | 'bo.order.completed'
  // BI — Stage 2D (BUILD-09). 'bi.insight.generated' is superseded by
  // 'bi.insight.published' (the insight package's actual dispatch point).
  | 'bi.metric.calculated'
  | 'bi.kpi.updated'
  | 'bi.analysis.started'
  | 'bi.analysis.completed'
  | 'bi.analysis.failed'
  | 'bi.anomaly.detected'
  | 'bi.forecast.generated'
  | 'bi.forecast.accuracy_recorded'
  | 'bi.insight.published'
  | 'bi.data.published'
  // DT — Stage 2E (BUILD-12).
  | 'dt.intake.received'
  | 'dt.intake.accepted'
  | 'dt.intake.rejected'
  | 'dt.definition.published'
  | 'dt.instance.created'
  | 'dt.instance.status_changed'
  | 'dt.snapshot.created'
  | 'dt.snapshot.validated'
  | 'dt.snapshot.published'
  | 'dt.calibration.started'
  | 'dt.calibration.completed'
  | 'dt.calibration.failed'
  | 'dt.validation.completed'
  | 'dt.scenario_baseline.created'
  | 'dt.scenario_baseline.published'
  | 'dt.data.published'
  // SIM — Stage 2F (BUILD-13). 'simulation.completed' is superseded by
  // 'sim.run.completed' (the run's actual completion event).
  | 'sim.intake.received'
  | 'sim.scenario.created'
  | 'sim.run.requested'
  | 'sim.run.started'
  | 'sim.run.completed'
  | 'sim.run.failed'
  | 'sim.result.published'
  | 'sim.risk.calculated'
  | 'sim.sensitivity.completed'
  | 'sim.data.published'
  // ADI — Stage 2G (BUILD-14). 'adi.decision.generated' is superseded by
  // 'adi.recommendation.generated' (the recommendation's actual generation event).
  | 'adi.intake.received'
  | 'adi.reasoning.started'
  | 'adi.reasoning.completed'
  | 'adi.reasoning.failed'
  | 'adi.alternative.evaluated'
  | 'adi.recommendation.generated'
  | 'adi.confidence.calculated'
  | 'adi.guardrail.violated'
  | 'adi.decision.published'
  | 'adi.data.published'
  | 'adi.decision.generated'
  // ABA — Stage 2H (BUILD-15). 'aba.action.approved' is the same canonical
  // event named in CLAUDE.md §9 — reused here, not superseded.
  | 'aba.intake.received'
  | 'aba.review.requested'
  | 'aba.review.started'
  | 'aba.action.approved'
  | 'aba.action.approved_with_modifications'
  | 'aba.action.rejected'
  | 'aba.action.held'
  | 'aba.action.released'
  | 'aba.action.published'
  | 'aba.data.published'
  // OM — Stage 2I (BUILD-16). 'om.outcome.evaluated' is the pre-existing
  // canonical event named in CLAUDE.md §9 — retained here, not superseded.
  | 'om.outcome.evaluated'
  | 'om.intake.received'
  | 'om.monitoring.started'
  | 'om.observation.recorded'
  | 'om.target.breached'
  | 'om.variance.calculated'
  | 'om.alert.raised'
  | 'om.incident.opened'
  | 'om.review.completed'
  | 'om.feedback.published'
  | 'om.data.published'
  // CL — Stage 2J (BUILD-17). 'cl.learning.published' is the pre-existing
  // canonical event named in CLAUDE.md §9 — retained here, not superseded.
  | 'cl.learning.published'
  | 'cl.intake.received'
  | 'cl.case.created'
  | 'cl.lesson.created'
  | 'cl.pattern.detected'
  | 'cl.model.drift_detected'
  | 'cl.policy.evaluated'
  | 'cl.improvement.proposed'
  | 'cl.change.approved'
  | 'cl.feedback.published'
  | 'cl.data.published'
  // Extension point — custom events must still use dot notation
  | (string & {});
