import { describe, expect, it } from 'vitest';
import { EventDeliveryAttemptRepository } from '../src/eventing/index.js';

const ctx = {
  tenantId: '22222222-2222-4222-8222-222222222222',
  workspaceId: '33333333-3333-4333-8333-333333333333',
  userId: '44444444-4444-4444-8444-444444444444',
};

describe('EventDeliveryAttemptRepository architecture guards', () => {
  const repository = new EventDeliveryAttemptRepository();

  it('rejects non-terminal started status before touching the database', async () => {
    await expect(repository.record(ctx, {
      outboxEventId: '11111111-1111-4111-8111-111111111111',
      attemptNumber: 1,
      status: 'started' as never,
      attemptedAt: new Date('2026-10-05T03:00:00.000Z'),
      completedAt: new Date('2026-10-05T03:00:01.000Z'),
      latencyMs: 1000,
    })).rejects.toThrow('DELIVERY_ATTEMPT_TERMINAL_STATUS_REQUIRED');
  });

  it('rejects completion before attempt start', async () => {
    await expect(repository.record(ctx, {
      outboxEventId: '11111111-1111-4111-8111-111111111111',
      attemptNumber: 1,
      status: 'succeeded',
      attemptedAt: new Date('2026-10-05T03:00:02.000Z'),
      completedAt: new Date('2026-10-05T03:00:01.000Z'),
      latencyMs: 1,
    })).rejects.toThrow('DELIVERY_ATTEMPT_COMPLETED_BEFORE_STARTED');
  });

  it('requires controlled failure evidence for failed attempts', async () => {
    await expect(repository.record(ctx, {
      outboxEventId: '11111111-1111-4111-8111-111111111111',
      attemptNumber: 1,
      status: 'failed',
      attemptedAt: new Date('2026-10-05T03:00:00.000Z'),
      completedAt: new Date('2026-10-05T03:00:01.000Z'),
      latencyMs: 1000,
    })).rejects.toThrow('DELIVERY_ATTEMPT_FAILURE_REQUIRED');
  });
});
