/**
 * Shared live-PostgreSQL fixtures for the API integration tests: the full
 * BI -> DT -> Simulation -> ADI -> ABA-intake chain built through the real repositories.
 */
import {
  InsightPackageRepository, BIPublicationPackageRepository,
  DTIntakeRepository, DigitalTwinDefinitionRepository, DigitalTwinInstanceRepository,
  DigitalTwinSnapshotRepository, ScenarioBaselineRepository, DTPublicationPackageRepository,
  SimulationIntakeRepository, SimulationModelRepository, SimulationScenarioRepository,
  SimulationRunRepository, SimulationResultRepository, SimulationPublicationRepository,
  ADIIntakeRepository, DecisionQuestionRepository, DecisionCaseRepository,
  DecisionRecommendationRepository, ADIPublicationRepository, ABAIntakeRepository,
  type TenantContext,
} from '@infinicus/database';

export function uc(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Persisted ADI facts a fixture recommendation is authored with (the same shape DecisionRecommendationRepository accepts). */
export type AbaFacts = NonNullable<Parameters<DecisionRecommendationRepository['createRecommendation']>[6]>;

/** Full BI -> DT -> Simulation -> ADI -> ABA-intake fixture chain (same proven pattern as BUILD-20's workflow tests). */
/** Persisted facts that pass the approval gate; tests needing unclassified/unknown pass `{}` or a subset. */
export const APPROVABLE_FACTS = { riskClass: 'low', isTimeSensitive: false } as const;

export async function createAbaFixture(ctx: TenantContext, businessId: string, facts: AbaFacts = APPROVABLE_FACTS): Promise<{ intakePackageId: string; recommendationId: string }> {
  const insightRepo = new InsightPackageRepository();
  const biPubRepo = new BIPublicationPackageRepository();
  const biPkg = await insightRepo.create(ctx, businessId, uc('insight'));
  const biVersion = await insightRepo.publishVersion(ctx, biPkg.id, businessId, { summary: 'api fixture BI' });
  const { package: biPub } = await biPubRepo.publish(ctx, businessId, biVersion.id, 'business_digital_twin', 'DT-01', uc('idem'));

  const dtIntakeRepo = new DTIntakeRepository();
  await dtIntakeRepo.receivePackage(ctx, { businessId, biPublicationPackageId: biPub.id, intakeCode: uc('dt-intake'), idempotencyKey: uc('idem') });
  const defRepo = new DigitalTwinDefinitionRepository();
  const definition = await defRepo.createDefinition(ctx, businessId, uc('def'), 'API Fixture Definition');
  const defVersion = await defRepo.createVersion(ctx, definition.id, businessId, {});
  await defRepo.validateVersion(ctx, defVersion.id);
  await defRepo.activateVersion(ctx, defVersion.id);
  const instRepo = new DigitalTwinInstanceRepository();
  const instance = await instRepo.createInstance(ctx, businessId, definition.id, uc('inst'));
  await instRepo.transitionStatus(ctx, instance.id, 'active');
  const snapRepo = new DigitalTwinSnapshotRepository();
  const { snapshot, version: snapVersion } = await snapRepo.createSnapshot(ctx, businessId, instance.id, uc('snap'), new Date(), 'api fixture snapshot');
  await snapRepo.validateSnapshot(ctx, snapshot.id, snapVersion.id);
  await snapRepo.publishSnapshot(ctx, snapshot.id, snapVersion.id);
  const baselineRepo = new ScenarioBaselineRepository();
  const { baseline, version: baselineVersion } = await baselineRepo.createBaseline(ctx, businessId, instance.id, snapVersion.id, uc('base'), 'api fixture objective');
  await baselineRepo.validateBaseline(ctx, baseline.id, baselineVersion.id);
  await baselineRepo.publishBaseline(ctx, baseline.id, baselineVersion.id);
  const dtPubRepo = new DTPublicationPackageRepository();
  const dtInsight = await dtPubRepo.createInsightPackage(ctx, businessId, uc('dt-insight'));
  const dtInsightVersion = await dtPubRepo.createVersion(ctx, dtInsight.id, businessId, 'DT->SIM api fixture', { snapshotVersionId: snapVersion.id, scenarioBaselineVersionId: baselineVersion.id });
  const { package: dtPub } = await dtPubRepo.createPackage(ctx, businessId, dtInsightVersion.id, 'simulation', 'SIM-01', uc('idem'));

  const simIntakeRepo = new SimulationIntakeRepository();
  await simIntakeRepo.receivePackage(ctx, { businessId, dtPublicationPackageId: dtPub.id, intakeCode: uc('sim-intake'), idempotencyKey: uc('idem') });
  const modelRepo = new SimulationModelRepository();
  const model = await modelRepo.createModel(ctx, businessId, uc('model'), 'Engine v3 Model');
  const modelVersion = await modelRepo.createVersion(ctx, model.id, businessId, 'infinicus-engine-v3', {});
  const scenarioRepo = new SimulationScenarioRepository();
  const scenario = await scenarioRepo.createScenario(ctx, businessId, model.id, uc('scn'), 'API Fixture Scenario');
  const scenarioVersion = await scenarioRepo.createVersion(ctx, scenario.id, businessId);
  const runRepo = new SimulationRunRepository();
  const { request } = await runRepo.createRequest(ctx, businessId, scenarioVersion.id, uc('req'), uc('idem'));
  await runRepo.createRun(ctx, businessId, request.id, modelVersion.id, uc('run'));
  const runs = await runRepo.listForBusiness(ctx, businessId);
  const resultRepo = new SimulationResultRepository();
  const { result, version: resultVersion } = await resultRepo.createResult(ctx, businessId, runs[0].id, uc('result'), 'api fixture result');
  await resultRepo.validateResult(ctx, result.id, resultVersion.id);
  await resultRepo.publishResult(ctx, result.id, resultVersion.id);
  const pubRepo = new SimulationPublicationRepository();
  const simInsight = await pubRepo.createInsightPackage(ctx, businessId, uc('sim-insight'));
  const simInsightVersion = await pubRepo.createVersion(ctx, simInsight.id, businessId, 'SIM->ADI api fixture', resultVersion.id);
  const { package: simPub } = await pubRepo.createPackage(ctx, businessId, simInsightVersion.id, 'ai_decision_intelligence', 'ADI-06', uc('idem'));

  const adiIntakeRepo = new ADIIntakeRepository();
  await adiIntakeRepo.receivePackage(ctx, { businessId, simulationPublicationPackageId: simPub.id, intakeCode: uc('adi-intake'), idempotencyKey: uc('idem') });
  const questionRepo = new DecisionQuestionRepository();
  const question = await questionRepo.createQuestion(ctx, businessId, uc('q'), 'Should we expand?');
  const caseRepo = new DecisionCaseRepository();
  const case_ = await caseRepo.createCase(ctx, businessId, question.id, uc('case'));
  const recRepo = new DecisionRecommendationRepository();
  const { recommendation, version: recVersion } = await recRepo.createRecommendation(ctx, businessId, case_.id, uc('rec'), 'api fixture recommendation', undefined, facts);
  await recRepo.validateRecommendation(ctx, recommendation.id, recVersion.id);
  await recRepo.publishRecommendation(ctx, recommendation.id, recVersion.id);
  const adiPubRepo = new ADIPublicationRepository();
  const adiInsight = await adiPubRepo.createInsightPackage(ctx, businessId, uc('adi-insight'));
  const adiInsightVersion = await adiPubRepo.createVersion(ctx, adiInsight.id, businessId, 'ADI->ABA api fixture', recVersion.id);
  const { package: adiPub } = await adiPubRepo.createPackage(ctx, businessId, adiInsightVersion.id, 'approved_business_action', 'ABA-01', uc('idem'));

  const intakeRepo = new ABAIntakeRepository();
  const { package: intakePkg } = await intakeRepo.receivePackage(ctx, { businessId, adiPublicationPackageId: adiPub.id, intakeCode: uc('aba-intake'), idempotencyKey: uc('idem') });
  return { intakePackageId: intakePkg.id, recommendationId: recommendation.id };
}

/** The ABA intake package alone (see createAbaFixture). */
export async function createAbaIntake(ctx: TenantContext, businessId: string, facts: AbaFacts = APPROVABLE_FACTS): Promise<string> {
  return (await createAbaFixture(ctx, businessId, facts)).intakePackageId;
}

