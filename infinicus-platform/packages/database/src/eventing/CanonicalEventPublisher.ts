import type { TenantContext } from '../client.js';
import type { BusinessEventContractRegistry } from '@infinicus/event-contracts';
import { EventLedgerRepository } from './EventLedgerRepository.js';
import { OutboxRepository } from './OutboxRepository.js';
import {
  LegacyOutboxCompatibilityRegistry,
  outboxRecordToCanonicalEvent,
  type LegacyOutboxRecord,
} from './LegacyOutboxCompatibility.js';

export interface CanonicalPublishResult {
  eventId: string;
  eventType: string;
  eventVersion: string;
  status: 'published';
}

export class CanonicalEventPublisher {
  constructor(
    private readonly contracts: BusinessEventContractRegistry,
    private readonly compatibility = new LegacyOutboxCompatibilityRegistry(),
    private readonly ledger = new EventLedgerRepository(),
    private readonly outbox = new OutboxRepository(),
  ) {}

  async publishClaimed(
    ctx: TenantContext,
    row: LegacyOutboxRecord,
  ): Promise<CanonicalPublishResult> {
    if (row.tenant_id !== ctx.tenantId || row.workspace_id !== ctx.workspaceId) {
      throw new Error('EVENTING_SCOPE_MISMATCH');
    }

    const event = outboxRecordToCanonicalEvent(row, this.compatibility);
    const validation = this.contracts.validate(event);
    if (!validation.valid) {
      throw new Error(`canonical_event_contract_rejected:${validation.reasons.join(',')}`);
    }

    // Ledger append is idempotent by event identity/idempotency key. Marking the
    // outbox published is a separate delivery-state transition. If that second
    // step fails, at-least-once retry reuses the same immutable ledger event.
    await this.ledger.append(ctx, event);
    await this.outbox.markPublished(ctx, row.id, new Date());

    return {
      eventId: event.eventId,
      eventType: validation.canonicalEventType ?? event.eventType,
      eventVersion: event.eventVersion,
      status: 'published',
    };
  }
}
