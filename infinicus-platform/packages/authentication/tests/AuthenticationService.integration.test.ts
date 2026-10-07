/**
 * Live PostgreSQL 16 integration tests for AuthenticationService, exercising
 * the full register/login/logout/validateSession/revoke/changePassword
 * lifecycle against the real identity.users / identity.sessions /
 * audit.access_events tables (BUILD-18).
 *
 * Requires:
 *   DATABASE_URL — app_test_user (RLS enforced)
 *
 * Guard pattern: describe.runIf(!!process.env.DATABASE_URL)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPool, closePool, UserRepository, SessionRepository, AccessEventRepository, EmailVerificationTokenRepository } from '@infinicus/database';
import { AuthenticationService } from '../src/AuthenticationService.js';
import { generateSessionToken, hashToken } from '../src/tokens.js';
import {
  InvalidCredentialsError, AccountNotActiveError, AccountLockedError,
  SessionExpiredError, SessionRevokedError, SessionInvalidError,
  VerificationTokenInvalidError,
} from '../src/errors.js';
import type { EmailMessage, EmailSender } from '../src/email/EmailSender.js';

const run = !!process.env.DATABASE_URL;

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@authsvc-test.example`;
}

const STRONG_PASSWORD = 'Correct-Horse-9!';

/** Captures every message "sent" instead of making a real HTTP call — lets tests recover the raw verification token, which is otherwise never returned from register()'s own public API (see AuthenticationService.register()'s doc comment: it's emailed, not returned). */
class CapturingEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }
  lastToken(): string {
    const last = this.sent[this.sent.length - 1];
    const match = /[?&]token=([^&\s]+)/.exec(last.text);
    if (!match) throw new Error('no token found in captured email');
    return decodeURIComponent(match[1]);
  }
}

async function registerAndActivate(service: AuthenticationService, users: UserRepository, email = uniqueEmail('svc')) {
  const user = await service.register(email, STRONG_PASSWORD);
  const active = await users.activate(user.id);
  return { email, user: active };
}

describe.runIf(run)('AuthenticationService — live PostgreSQL', () => {
  const users = new UserRepository();
  const sessions = new SessionRepository();
  const accessEvents = new AccessEventRepository();
  const verificationTokens = new EmailVerificationTokenRepository();
  const emailSender = new CapturingEmailSender();
  const service = new AuthenticationService(users, sessions, accessEvents, verificationTokens, emailSender, {
    apiKey: undefined, fromAddress: 'test@authsvc-test.example', verificationUrlBase: 'https://example.test/verify',
  });

  beforeAll(() => {
    createPool({ connectionString: process.env.DATABASE_URL! });
  });

  afterAll(async () => {
    await closePool();
  });

  describe('register', () => {
    it('activates the account immediately — never leaves it pending from the caller\'s perspective', async () => {
      const user = await service.register(uniqueEmail('reg'), STRONG_PASSWORD);
      expect(user.status).toBe('active');
    });

    it('an immediately-registered account can log in right away, with no separate activation step', async () => {
      const email = uniqueEmail('reg-login');
      await service.register(email, STRONG_PASSWORD);
      await expect(service.login(email, STRONG_PASSWORD)).resolves.toBeDefined();
    });

    it('stores a bcrypt hash, never the plaintext password', async () => {
      const email = uniqueEmail('reg-hash');
      const user = await service.register(email, STRONG_PASSWORD);
      const hash = await users.getPasswordHash(user.id);
      expect(hash).not.toBe(STRONG_PASSWORD);
      expect(hash?.startsWith('$2')).toBe(true);
    });

    it('rejects registration with a weak password before creating any user row', async () => {
      const email = uniqueEmail('reg-weak');
      await expect(service.register(email, 'weak')).rejects.toThrow();
      await expect(users.getByEmail(email)).rejects.toThrow();
    });

    it('sends a real verification email as a side effect, with a token that verifies the account', async () => {
      const email = uniqueEmail('reg-verify');
      const before = emailSender.sent.length;
      const user = await service.register(email, STRONG_PASSWORD);
      expect(emailSender.sent.length).toBe(before + 1);
      expect(emailSender.sent[emailSender.sent.length - 1].to).toBe(email);
      expect(user.emailVerifiedAt).toBeNull();

      const rawToken = emailSender.lastToken();
      const verified = await service.verifyEmail(rawToken);
      expect(verified.id).toBe(user.id);
      expect(verified.emailVerifiedAt).not.toBeNull();
      // Verifying email never changes account usability — it's tracked independently (see register()'s own doc comment).
      expect(verified.status).toBe('active');
    });

    it('rejects an already-used verification token on a second attempt', async () => {
      const email = uniqueEmail('reg-reuse');
      await service.register(email, STRONG_PASSWORD);
      const rawToken = emailSender.lastToken();
      await service.verifyEmail(rawToken);
      await expect(service.verifyEmail(rawToken)).rejects.toBeInstanceOf(VerificationTokenInvalidError);
    });

    it('rejects an unknown verification token', async () => {
      await expect(service.verifyEmail(generateSessionToken())).rejects.toBeInstanceOf(VerificationTokenInvalidError);
    });

    it('rejects an expired verification token', async () => {
      const email = uniqueEmail('reg-expired');
      const user = await service.register(email, STRONG_PASSWORD);
      const rawToken = generateSessionToken();
      await verificationTokens.create(user.id, hashToken(rawToken), new Date(Date.now() - 1000));
      await expect(service.verifyEmail(rawToken)).rejects.toBeInstanceOf(VerificationTokenInvalidError);
    });
  });

  describe('login', () => {
    it('succeeds for an active user with the correct password and records a login access event', async () => {
      const { email, user } = await registerAndActivate(service, users);
      const result = await service.login(email, STRONG_PASSWORD, { ipAddress: '10.0.0.1', userAgent: 'vitest' });
      expect(result.user.id).toBe(user.id);
      expect(result.session.userId).toBe(user.id);
      expect(result.rawSessionToken).toHaveLength(64);

      const events = await accessEvents.listForUser(user.id);
      expect(events.some((e) => e.eventType === 'login')).toBe(true);
    });

    it('updates last_login_at on successful login', async () => {
      const { email, user } = await registerAndActivate(service, users);
      expect(user.lastLoginAt).toBeNull();
      await service.login(email, STRONG_PASSWORD);
      const reloaded = await users.getById(user.id);
      expect(reloaded.lastLoginAt).not.toBeNull();
    });

    it('rejects an unknown email and records a failed_auth access event', async () => {
      const unknownEmail = uniqueEmail('never-registered');
      await expect(service.login(unknownEmail, STRONG_PASSWORD)).rejects.toBeInstanceOf(InvalidCredentialsError);
    });

    it('rejects the correct email with a wrong password and records a failed_auth access event', async () => {
      const { email, user } = await registerAndActivate(service, users);
      await expect(service.login(email, 'Totally-Wrong-9!')).rejects.toBeInstanceOf(InvalidCredentialsError);
      const events = await accessEvents.listForUser(user.id);
      expect(events.some((e) => e.eventType === 'failed_auth')).toBe(true);
    });

    it('login\'s active-status guard still rejects a genuinely pending account (defense in depth — register() itself no longer produces one, but the guard must still hold for any account created outside it)', async () => {
      const email = uniqueEmail('pending');
      const passwordHash = await users.getPasswordHash((await service.register(email, STRONG_PASSWORD)).id);
      const directlyCreated = await users.createUser({ email: uniqueEmail('pending-direct'), passwordHash: passwordHash! });
      expect(directlyCreated.status).toBe('pending');
      await expect(service.login(directlyCreated.email, STRONG_PASSWORD)).rejects.toBeInstanceOf(AccountNotActiveError);
    });

    it('rejects login for a suspended account', async () => {
      const { email, user } = await registerAndActivate(service, users);
      await users.suspend(user.id);
      await expect(service.login(email, STRONG_PASSWORD)).rejects.toBeInstanceOf(AccountNotActiveError);
    });
  });

  // Each lockout test performs about 7 bcryptjs (pure-JavaScript, deliberately
  // slow) operations. They take ~2 s locally but exceeded the 5 s default on
  // loaded parallel CI runners. This per-test allowance only accommodates
  // runner speed: bcrypt cost, lockout thresholds and assertions are unchanged.
  const LOCKOUT_TEST_TIMEOUT_MS = 20_000;

  describe('login — account lockout', () => {
    it('locks the account after 5 bad-password attempts within the window, even with the correct password on the 6th try', async () => {
      const { email } = await registerAndActivate(service, users);
      for (let i = 0; i < 5; i++) {
        await expect(service.login(email, 'Wrong-Password-9!')).rejects.toBeInstanceOf(InvalidCredentialsError);
      }
      await expect(service.login(email, STRONG_PASSWORD)).rejects.toBeInstanceOf(AccountLockedError);
    }, LOCKOUT_TEST_TIMEOUT_MS);

    it('records a failed_auth access event with reason=account_locked when lockout triggers', async () => {
      const { email, user } = await registerAndActivate(service, users);
      for (let i = 0; i < 5; i++) {
        await expect(service.login(email, 'Wrong-Password-9!')).rejects.toBeInstanceOf(InvalidCredentialsError);
      }
      await expect(service.login(email, STRONG_PASSWORD)).rejects.toBeInstanceOf(AccountLockedError);
      const events = await accessEvents.listForUser(user.id);
      const lockEvent = events.find((e) => e.eventType === 'failed_auth' && e.metadata.reason === 'account_locked');
      expect(lockEvent).toBeDefined();
    }, LOCKOUT_TEST_TIMEOUT_MS);

    it('does not lock an account that has fewer than the threshold\'s worth of recent failures', async () => {
      const { email } = await registerAndActivate(service, users);
      for (let i = 0; i < 4; i++) {
        await expect(service.login(email, 'Wrong-Password-9!')).rejects.toBeInstanceOf(InvalidCredentialsError);
      }
      // The 5th attempt is the correct password — must succeed, not lock,
      // since only 4 *failed* attempts have happened so far.
      await expect(service.login(email, STRONG_PASSWORD)).resolves.toBeDefined();
    }, 15_000);

    it('an unknown email never locks (there is no account to lock, and no userId to count failures against)', async () => {
      const unknownEmail = uniqueEmail('lockout-unknown');
      for (let i = 0; i < 10; i++) {
        await expect(service.login(unknownEmail, 'Wrong-Password-9!')).rejects.toBeInstanceOf(InvalidCredentialsError);
      }
    });
  });

  describe('logout', () => {
    it('revokes the session for a valid raw session token', async () => {
      const { email } = await registerAndActivate(service, users);
      const { session, rawSessionToken } = await service.login(email, STRONG_PASSWORD);
      await service.logout(rawSessionToken);
      const reloaded = await sessions.getById(session.id);
      expect(reloaded.revokedAt).not.toBeNull();
    });

    it('is idempotent for an already-revoked session', async () => {
      const { email } = await registerAndActivate(service, users);
      const { rawSessionToken } = await service.login(email, STRONG_PASSWORD);
      await service.logout(rawSessionToken);
      await expect(service.logout(rawSessionToken)).resolves.toBeUndefined();
    });

    it('is a silent no-op for an unknown session token', async () => {
      await expect(service.logout(generateSessionToken())).resolves.toBeUndefined();
    });
  });

  describe('validateSession', () => {
    it('returns the user and session for a valid, active session', async () => {
      const { email, user } = await registerAndActivate(service, users);
      const { rawSessionToken } = await service.login(email, STRONG_PASSWORD);
      const validated = await service.validateSession(rawSessionToken);
      expect(validated.user.id).toBe(user.id);
    });

    it('throws SessionInvalidError for an unknown raw token', async () => {
      await expect(service.validateSession(generateSessionToken())).rejects.toBeInstanceOf(SessionInvalidError);
    });

    it('throws SessionRevokedError for a revoked session', async () => {
      const { email } = await registerAndActivate(service, users);
      const { rawSessionToken } = await service.login(email, STRONG_PASSWORD);
      await service.logout(rawSessionToken);
      await expect(service.validateSession(rawSessionToken)).rejects.toBeInstanceOf(SessionRevokedError);
    });

    it('throws SessionExpiredError for an expired session', async () => {
      const { user } = await registerAndActivate(service, users);
      const rawToken = generateSessionToken();
      await sessions.createSession(user.id, hashToken(rawToken), new Date(Date.now() - 1000));
      await expect(service.validateSession(rawToken)).rejects.toBeInstanceOf(SessionExpiredError);
    });

    it('throws AccountNotActiveError when the owning account was suspended after the session was issued', async () => {
      const { email, user } = await registerAndActivate(service, users);
      const { rawSessionToken } = await service.login(email, STRONG_PASSWORD);
      await users.suspend(user.id);
      await expect(service.validateSession(rawSessionToken)).rejects.toBeInstanceOf(AccountNotActiveError);
    });
  });

  describe('revokeSession / revokeAllUserSessions', () => {
    it('revokeSession revokes a single session by id and records a session_revocation access event', async () => {
      const { email, user } = await registerAndActivate(service, users);
      const { session } = await service.login(email, STRONG_PASSWORD);
      await service.revokeSession(session.id);
      const reloaded = await sessions.getById(session.id);
      expect(reloaded.revokedAt).not.toBeNull();
      const events = await accessEvents.listForUser(user.id);
      expect(events.some((e) => e.eventType === 'session_revocation')).toBe(true);
    });

    it('revokeAllUserSessions revokes every active session for the user and returns the count', async () => {
      const { email, user } = await registerAndActivate(service, users);
      await service.login(email, STRONG_PASSWORD);
      await service.login(email, STRONG_PASSWORD);
      const count = await service.revokeAllUserSessions(user.id);
      expect(count).toBeGreaterThanOrEqual(2);
      const active = await sessions.listActiveForUser(user.id);
      expect(active).toHaveLength(0);
    });
  });

  describe('changePassword', () => {
    it('updates the password hash and allows login with the new password', async () => {
      const { email, user } = await registerAndActivate(service, users);
      const newPassword = 'New-Correct-Horse-9!';
      await service.changePassword(user.id, STRONG_PASSWORD, newPassword);
      await expect(service.login(email, newPassword)).resolves.toBeDefined();
    });

    it('rejects the change when the old password is wrong, leaving the original password intact', async () => {
      const { email, user } = await registerAndActivate(service, users);
      await expect(service.changePassword(user.id, 'Wrong-Old-Password-9!', 'New-Correct-Horse-9!')).rejects.toBeInstanceOf(InvalidCredentialsError);
      await expect(service.login(email, STRONG_PASSWORD)).resolves.toBeDefined();
    });

    it('revokes all existing sessions as a defense-in-depth side effect', async () => {
      const { email, user } = await registerAndActivate(service, users);
      const { rawSessionToken } = await service.login(email, STRONG_PASSWORD);
      await service.changePassword(user.id, STRONG_PASSWORD, 'New-Correct-Horse-9!');
      await expect(service.validateSession(rawSessionToken)).rejects.toBeInstanceOf(SessionRevokedError);
    });
  });
});

describe.skipIf(run)('AuthenticationService — live PostgreSQL (skipped, no DATABASE_URL)', () => {
  it('skips live tests when DATABASE_URL is not set', () => {
    expect(run).toBe(false);
  });
});
