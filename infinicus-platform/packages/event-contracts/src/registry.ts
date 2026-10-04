import type {
  BusinessDomain,
  BusinessEventEnvelope,
  BusinessEventSensitivity,
  BusinessEventValidationResult,
} from './business-event.js';
import { validateBusinessEventEnvelope } from './business-event.js';

export type ContractStatus = 'draft' | 'active' | 'deprecated' | 'retired';

export interface BusinessEventContract<TPayload = unknown> {
  eventType: string;
  eventVersion: string;
  schemaName: string;
  schemaVersion: string;
  ownerDomain: BusinessDomain;
  producer: string;
  supportedConsumers: readonly string[];
  sensitivity: BusinessEventSensitivity;
  status: ContractStatus;
  effectiveFrom: string;
  deprecatedAt: string | null;
  compatibilityAliases: readonly string[];
  validatePayload: (payload: unknown) => payload is TPayload;
}

export interface RegisteredValidationResult extends BusinessEventValidationResult {
  canonicalEventType?: string;
}

export const LEGACY_EVENT_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  'da.data.published': 'data.acquisition.package_published',
  'bo.inventory.movement_recorded': 'operations.inventory.movement_recorded',
  'bo.purchase_order.approved': 'operations.purchase_order.approved',
  'bo.order.completed': 'commerce.order.completed',
  'bo.invoice.issued': 'finance.invoice.issued',
});

export class BusinessEventContractRegistry {
  private readonly contracts = new Map<string, BusinessEventContract>();

  private key(eventType: string, eventVersion: string): string {
    return `${eventType}@${eventVersion}`;
  }

  register(contract: BusinessEventContract): void {
    const key = this.key(contract.eventType, contract.eventVersion);
    if (this.contracts.has(key)) throw new Error(`duplicate_event_contract:${key}`);
    this.contracts.set(key, Object.freeze({ ...contract }));
  }

  resolveEventType(eventType: string): string {
    return LEGACY_EVENT_ALIASES[eventType] ?? eventType;
  }

  get(eventType: string, eventVersion: string): BusinessEventContract | undefined {
    return this.contracts.get(this.key(this.resolveEventType(eventType), eventVersion));
  }

  listActive(): readonly BusinessEventContract[] {
    return [...this.contracts.values()].filter((c) => c.status === 'active');
  }

  validate(event: unknown): RegisteredValidationResult {
    const envelope = validateBusinessEventEnvelope(event);
    if (!envelope.valid) return envelope;

    const e = event as BusinessEventEnvelope;
    const canonicalEventType = this.resolveEventType(e.eventType);
    const contract = this.get(canonicalEventType, e.eventVersion);
    if (!contract) return { valid: false, reasons: ['event_contract_not_registered'], canonicalEventType };
    if (contract.status === 'retired') return { valid: false, reasons: ['event_contract_retired'], canonicalEventType };
    if (!contract.validatePayload(e.payload)) {
      return { valid: false, reasons: ['event_payload_invalid'], canonicalEventType };
    }
    return { valid: true, reasons: [], canonicalEventType };
  }
}
