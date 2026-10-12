/**
 * Composition root of the event worker (a composition root, like apps/api: the one place allowed to join ABA and BO implementations).
 *
 * Wires the P0-6b pipeline: contract registry (control_loop.action.authorized@1) -> OutboxDispatcher -> BO notification consumer ->
 * existing intake service, with the ABA-owned status provider / package source / consumption recorder behind the shared ports. BO sees
 * only the port types; ABA sees no BO type. The execution capability gate defaults to DENY ALL, BO's capability registry to its
 * production registry (which supports nothing until P0-6e), so a default-built worker acts on nothing.
 */
import { OutboxDispatcher } from '@infinicus/database';
import { BusinessEventContractRegistry, ACTION_AUTHORIZED_EVENT_TYPE, registerActionAuthorizedContract } from '@infinicus/event-contracts';
import { DENY_ALL_EXECUTION_GATE } from '@infinicus/handoff-contracts';
import type { ActionCapabilityRegistry, ExecutionCapabilityGate } from '@infinicus/handoff-contracts';
import { AuthorizedActionIntakeService, AuthorizedActionNotificationConsumer } from '@infinicus/business-operations-runtime';
import { AbaAuthorizedActionPackageSource, AbaPackageConsumptionRecorder, AbaPackageStatusProvider } from '@infinicus/workflow';
import { EventWorker } from './EventWorker.js';
import type { ScopeDiscovery } from './ScopeDiscovery.js';
import type { EventWorkerConfig } from './config.js';

export interface BuildEventWorkerOptions {
  config: EventWorkerConfig;
  discovery: ScopeDiscovery;
  /** Defaults to deny-all. The governed activation gate (P0-6e) is supplied here and nowhere else. */
  gate?: ExecutionCapabilityGate;
  /** Defaults to BO's production registry (supports nothing). Tests inject their own; production never does before P0-6e. */
  capabilities?: ActionCapabilityRegistry;
  clock?: () => Date;
  onScopeError?: (scope: { tenantId: string; workspaceId: string }, error: unknown) => void;
}

export function buildContractRegistry(): BusinessEventContractRegistry {
  const registry = new BusinessEventContractRegistry();
  registerActionAuthorizedContract(registry);
  return registry;
}

export function buildEventWorker(options: BuildEventWorkerOptions): EventWorker {
  const { config } = options;
  const statusProvider = new AbaPackageStatusProvider({ actorUserId: config.actorUserId });
  const consumer = new AuthorizedActionNotificationConsumer({
    intake: new AuthorizedActionIntakeService({
      statusProvider, statusMaxAgeMs: config.intakeStatusMaxAgeMs, ...(options.capabilities ? { capabilities: options.capabilities } : {}),
    }),
    source: new AbaAuthorizedActionPackageSource({ actorUserId: config.actorUserId }),
    recorder: new AbaPackageConsumptionRecorder({ actorUserId: config.actorUserId }),
    gate: options.gate ?? DENY_ALL_EXECUTION_GATE,
  });
  const eventTypes = [ACTION_AUTHORIZED_EVENT_TYPE];
  const dispatcher = new OutboxDispatcher({
    contracts: buildContractRegistry(),
    eventTypes,
    consumers: new Map([[AuthorizedActionNotificationConsumer.NAME, consumer]]),
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
