import { describe, it, expect, vi } from 'vitest';
import type { UserRepository, SessionRepository, AccessEventRepository } from '@infinicus/database';
import { AuthenticationService } from '../src/AuthenticationService.js';
import { LockoutStateUnavailableError } from '../src/errors.js';

describe('AUTH-LOCKOUT-1: required lockout-state read', () => {
  it('refuses login before password lookup or session creation when the lockout store fails; never emits sensitive exception text', async () => {
    const secret = 'postgresql://operator:synthetic-secret@db.invalid/protected';
    const users = {
      getByEmail: vi.fn().mockResolvedValue({ id: '00000000-0000-4000-8000-000000000001', email: 'user@example.test', status: 'active' }),
      getPasswordHash: vi.fn(),
    };
    const sessions = { create: vi.fn() };
    const accessEvents = { countRecentFailedPasswordAttempts: vi.fn().mockRejectedValue(new Error(secret)), record: vi.fn() };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const service = new AuthenticationService(
        users as unknown as UserRepository,
        sessions as unknown as SessionRepository,
        accessEvents as unknown as AccessEventRepository,
      );
      await expect(service.login('user@example.test', 'a-password')).rejects.toBeInstanceOf(LockoutStateUnavailableError);
      expect(users.getPasswordHash).not.toHaveBeenCalled();
      expect(sessions.create).not.toHaveBeenCalled();
      expect(accessEvents.record).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledOnce();
      expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
    } finally {
      warn.mockRestore();
    }
  });

  it('does not map a failed lockout read to a zero-failure state', async () => {
    const users = {
      getByEmail: vi.fn().mockResolvedValue({ id: '00000000-0000-4000-8000-000000000001' }),
      getPasswordHash: vi.fn(),
    };
    const accessEvents = { countRecentFailedPasswordAttempts: vi.fn().mockRejectedValue(new Error('unavailable')) };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const service = new AuthenticationService(
        users as unknown as UserRepository,
        { create: vi.fn() } as unknown as SessionRepository,
        accessEvents as unknown as AccessEventRepository,
      );
      await expect(service.login('user@example.test', 'password')).rejects.toThrow('Password login is temporarily unavailable');
      expect(users.getPasswordHash).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
