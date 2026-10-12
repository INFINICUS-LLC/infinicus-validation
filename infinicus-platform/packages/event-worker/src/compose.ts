/**
 * Composition root of the event worker (a composition root, like apps/api: the one place allowed to join ABA and BO implementations).
 *
 * Wires the P0-6b pipeline (and, from P0-6d, the BO -> OM execution-verification consumer): contract registry (control_loop.action.authorized@1) -> OutboxDispatcher -> BO notification consumer ->
 * existing intake service, with the ABA-owned status provider / package source / consumption recorder behind the shared ports. BO sees
 * only the port types; ABA sees no BO type. P0-6e adds the one trigger of execution (consumer -> engine) behind the GOVERNED gate: capability
 * registry AND a per-business activation record AND no kill switch. With no activation record a default-built worker acts on nothing.
 */
import { OutboxDispatcher } from '@infinicus/database';
import type { EventConsumer } from '@infinicus/database';
import {
  BusinessEventContractRegistry, ACTION_AUTHORIZED_EVENT_TYPE, registerActionAuthorizedContract, ACTION_EXECUTED_EVENT_TYPE, registerActionExecutedContract,
} from '@infinicus/event-contracts';
import type {
  ActionCapabilityRegistry, AuthoritativePackageStatusProvider, AuthorizedActionPackageSource, ExecutionCapabilityGate, PackageConsumptionRecorder,
} from '@infinicus/handoff-contracts';
import {
  AuthorizedActionExecutionService, AuthorizedActionIntakeService, AuthorizedActionNotificationConsumer, BoExecutionEvidenceReader, GovernedExecutionGate,
  PRODUCTION_BO_CAPABILITIES, killSwitchEngagedFrom,
} from '@infinicus/business-operations-runtime';
import { ActionExecutedConsumer, ExecutionVerificationService, OM_VERIFIABLE_ACTION_TYPES } from '@infinicus/outcome-monitoring-runtime';
import { AbaAuthorizedActionPackageSource, AbaPackageConsumptionRecorder, AbaPackageStatusProvider } from '@infinicus/workflow';
import { EventWorker } from './EventWorker.js';
import type { ScopeDiscovery } from './ScopeDiscovery.js';
import type { EventWorkerConfig } from './config.js';

export interface BuildEventWorkerOptions {
  config: EventWorkerConfig;
  discovery: ScopeDiscovery;
  /** Defaults to the GOVERNED gate (registry + per-business activation record + kill switch), which is closed until an administrator enables a business. Tests may inject a gate. */
  gate?: ExecutionCapabilityGate;
  /** Defaults to BO's production registry (exactly inventory_reorder_policy_update@1). Tests inject their own. */
  capabilities?: ActionCapabilityRegistry;
  /**
   * Seams for the three ABA-owned ports. Production composition leaves them unset (the real ABA implementations are used); tests that need a
   * package ABA never issued may substitute scripted ports. Nothing here can enable execution: the gate, registry and fresh authority check
   * still apply to whatever these ports answer.
   */
  ports?: {
    statusProvider?: AuthoritativePackageStatusProvider;
    source?: AuthorizedActionPackageSource;
    recorder?: PackageConsumptionRecorder;
  };
  /** Key 3 of the gate. Defaults to the process environment (absent = not engaged; anything unrecognised = engaged). */
  killSwitchEngaged?: () => boolean;
  clock?: () => Date;
  onScopeError?: (scope: { tenantId: string; workspaceId: string }, error: unknown) => void;
}

export function buildContractRegistry(): BusinessEventContractRegistry {
  const registry = new BusinessEventContractRegistry();
  registerActionAuthorizedContract(registry);
  registerActionExecutedContract(registry);
  return registry;
}

export function buildEventWorker(options: BuildEventWorkerOptions): EventWorker {
  const { config } = options;
  const statusProvider = options.ports?.statusProvider ?? new AbaPackageStatusProvider({ actorUserId: config.actorUserId });
  const capabilities = options.capabilities ?? PRODUCTION_BO_CAPABILITIES;
  // ONE gate instance governs both the consumer (before the claim) and the engine (again, under the target lock).
  const gate = options.gate ?? new GovernedExecutionGate({
    capabilities, killSwitchEngaged: options.killSwitchEngaged ?? (() => killSwitchEngagedFrom(process.env)), actorUserId: config.actorUserId,
  });
  // ONE executor: the BO engine. The consumer below is its only caller; the status answer is judged fresh, under lock, within the ruled age.
  const executor = new AuthorizedActionExecutionService({ statusProvider, executionStatusMaxAgeMs: config.executionStatusMaxAgeMs, gate, capabilities });
  const consumer = new AuthorizedActionNotificationConsumer({
    intake: new AuthorizedActionIntakeService({ statusProvider, statusMaxAgeMs: config.intakeStatusMaxAgeMs, capabilities }),
    source: options.ports?.source ?? new AbaAuthorizedActionPackageSource({ actorUserId: config.actorUserId }),
    recorder: options.ports?.recorder ?? new AbaPackageConsumptionRecorder({ actorUserId: config.actorUserId }),
    gate,
    executor,
  });
  // P0-6d: OM verifies BO execution evidence. It reads the evidence only through BO's read port and writes only OM's own verification table.
  const executedConsumer = new ActionExecutedConsumer({
    verification: new ExecutionVerificationService({
      evidence: new BoExecutionEvidenceReader({ actorUserId: config.actorUserId }), supportedActionTypes: OM_VERIFIABLE_ACTION_TYPES,
    }),
  });
  const eventTypes = [ACTION_AUTHORIZED_EVENT_TYPE, ACTION_EXECUTED_EVENT_TYPE];
  const dispatcher = new OutboxDispatcher({
    contracts: buildContractRegistry(),
    eventTypes,
    consumers: new Map<string, EventConsumer>([[AuthorizedActionNotificationConsumer.NAME, consumer], [ActionExecutedConsumer.NAME, executedConsumer]]),
    workerId: config.workerId,
    claimTimeoutMs: config.claimTimeoutMs,
    ...(options.clock ? { clock: options.clock } : {}),
  });
  return new EventWorker({
    discovery: options.discovery, dispatcher, eventTypes, actorUserId: config.actorUserId, batchSize: config.batchSize,
    claimTimeoutMs: config.claimTimeoutMs, maxScopesPerCycle: config.maxScopesPerCycle,
    ...(options.clock ? { clock: options.clock } : {}), ...(options.onScopeError ? { onScopeError: options.onScopeError } : {}),
  });
}
