/**
 * The composition point of the Digital Twin -> Simulation hand-off of the published business performance state (NEW-BDT-SIM-01). It reads the twin's own
 * published state through the business performance twin service and touches nothing of Business Operations, Business Intelligence or Simulation.
 */
import { PerformanceSimulationHandoffService, type PerformanceSimulationHandoffDependencies } from '@infinicus/workflow';
import { buildBusinessPerformanceTwinService } from './businessPerformanceTwinComposition.js';

export interface PerformanceSimulationHandoffCompositionOptions { service?: PerformanceSimulationHandoffService }

export function buildPerformanceSimulationHandoffService(overrides: Partial<PerformanceSimulationHandoffDependencies> = {}): PerformanceSimulationHandoffService {
  return new PerformanceSimulationHandoffService({ twin: buildBusinessPerformanceTwinService(), ...overrides });
}
